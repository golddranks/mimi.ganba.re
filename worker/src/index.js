// Anonymous per-answer stats sink for mimi.ganba.re.
// Endpoints:
//   POST /v1/events                 body: { uid, events: [{ts, target, idx, picked, cap}, ...] }
//   POST /v1/user                   body: { uid, nickname }
//   GET  /v1/user/:uid               { power_user: 0|1|2 } — used by the dashboard to decide whether to show the uid-load form
//   GET  /v1/user/:uid/events       all events for a single user
//   GET  /v1/admin/stats?uid=…      sound/aggregate stats with no device identifiers; requires power_user >= 1
//   GET  /v1/admin/stats/users?uid=…  per-user / uid-drilldown stats; requires power_user >= 2
//
// power_user tiers: 0 = none, 1 = may see the /stats/ page (the overview
// counters, hour-of-day, per-sound + sound-file difficulty, both confusion
// matrices), 2 = may also see the /admin/ page (the per-user histograms, daily
// activity, and the uid drill-downs / nicknames). The two admin endpoints map
// 1:1 onto the tiers.

import { nameOf } from "./voicemap.js";
import { MIGRATIONS } from "./migrations.js";
import { levelIdx, onCorrect, onWrong, onRelisten } from "../../src/shared/skill.js";
import { confusionRecord } from "../../src/shared/tally.js";
import { isAnswerEv, answeredRight } from "../../src/shared/events.js";
import { VAPID_PUBLIC_KEY } from "../../src/shared/vapid.js";
import { localStamp, dueNudge, vapidAuth, encryptPayload, sendPush, NUDGE_TEXT, START_HOUR, DONE_HOUR } from "./push.js";

// Production aggregates show only normal users (role 0): non-normal roles —
// 1 = automatic (e2e/seed) test users, 2 = native test users (forced-pair
// drilling, which would skew normal stats) — are excluded. uids with no users
// row (shouldn't happen; every event POST upserts one) count as normal.
// SQL-injection note: hard-coded fragment, never user-input. Two other role
// predicates exist for their own contexts: roleFilter() for the confusion
// matrices (role 0 XOR role 2 via the admin toggle) and the native pair-ranking
// (role != 1).
const EXCLUDE_TEST = "uid NOT IN (SELECT uid FROM users WHERE role != 0)";

// SQL mirror of src/shared/events.js: which events are answers, and the 1/0
// "answered right" expression (the Y/N "no" inverts — right when picked != target).
// Kept here as fragments so the answer/accuracy aggregates below stay in step with
// the JS the dashboard and push use. Hard-coded, never user input.
const ANSWER_EVS = "ev IN ('a','g','y','n')";
const CORRECT = "CASE WHEN ev = 'n' THEN picked <> target ELSE picked = target END";

// users.power_user for a uid, 0 if unknown. The admin endpoints gate on this.
// In local dev (scripts/dev.sh runs `wrangler dev --var DEV:1`) every uid is
// treated as full power_user 2, so admin/dashboard gating doesn't get in the
// way; the var is dev-only and never present in a deployed worker.
async function powerLevel(env, uid) {
  if (env.DEV) return 2;
  const row = await env.mimi_stats.prepare(
    "SELECT power_user FROM users WHERE uid = ?"
  ).bind(uid).first();
  return row ? row.power_user : 0;
}

const ALLOWED_ORIGINS = [
  "https://mimi.ganba.re",
];
const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

function corsHeaders(origin) {
  const ok =
    ALLOWED_ORIGINS.includes(origin) ||
    ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin || ""));
  if (!ok) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });

// Run a statement, swallowing only SQLite's "duplicate column name". SQLite has
// no `ADD COLUMN IF NOT EXISTS`, so this is how ADD COLUMN stays idempotent — a
// fresh DB built from schema.sql (columns already present) or a concurrent
// isolate that won the race both land here. Any other error propagates.
async function runIgnoringDupColumn(stmt) {
  try { await stmt.run(); }
  catch (e) { if (!/duplicate column name/i.test((e && e.message) || "")) throw e; }
}

// Schema migrations run lazily on the first request each isolate handles, so a
// code deploy that needs a new column self-heals the DB rather than 500ing
// against the old schema. Cached per isolate; a failure clears the cache so
// the next request retries instead of wedging on a stale rejection.
let migration = null;
function ensureMigrated(env) {
  return (migration ||= runMigrations(env).catch((e) => { migration = null; throw e; }));
}

async function runMigrations(env) {
  const db = env.mimi_stats;
  // The ledger stores the up + down SQL of each applied migration, so the DB
  // can be rolled back without the code that defined it (see rollback below).
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS migrations (" +
    "id INTEGER PRIMARY KEY, up_sql TEXT, down_sql TEXT, applied_at INTEGER NOT NULL)"
  ).run();
  // Self-heal an older 2-column ledger (id, applied_at) left by a previous
  // version of this runner — same forward-deploy hazard, one level down.
  await runIgnoringDupColumn(db.prepare("ALTER TABLE migrations ADD COLUMN up_sql TEXT"));
  await runIgnoringDupColumn(db.prepare("ALTER TABLE migrations ADD COLUMN down_sql TEXT"));

  const done = new Set(
    ((await db.prepare("SELECT id FROM migrations").all()).results || []).map((r) => r.id)
  );
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await runIgnoringDupColumn(db.prepare(m.up));
    // Capture both directions verbatim so a rollback never depends on this list.
    await db.prepare(
      "INSERT OR IGNORE INTO migrations (id, up_sql, down_sql, applied_at) VALUES (?, ?, ?, ?)"
    ).bind(m.id, m.up, m.down ?? null, Date.now()).run();
  }
}

// Reverse every applied migration with id > toId, newest first, running the
// `down_sql` stored in the ledger — NOT from MIGRATIONS — so a deploy that
// predates a migration can still undo it. Refuses if any migration in range is
// irreversible (down_sql IS NULL) rather than leaving the schema half-reverted.
// Deliberately manual: never on the request path, because a routine rollback
// deploy must not silently drop columns. Returns the ids reversed.
export async function rollback(env, toId) {
  const db = env.mimi_stats;
  const rows = ((await db.prepare(
    "SELECT id, down_sql FROM migrations WHERE id > ? ORDER BY id DESC"
  ).bind(toId).all()).results) || [];
  const irreversible = rows.filter((r) => r.down_sql == null).map((r) => r.id);
  if (irreversible.length) {
    throw new Error(`cannot roll back: migrations ${irreversible.join(", ")} are irreversible (down_sql is null)`);
  }
  for (const r of rows) {
    await db.prepare(r.down_sql).run();
    await db.prepare("DELETE FROM migrations WHERE id = ?").bind(r.id).run();
  }
  return rows.map((r) => r.id);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    const cors = corsHeaders(origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let res;
    try {
      await ensureMigrated(env);
      if (req.method === "POST" && url.pathname === "/v1/events") {
        res = await handleEvents(req, env);
      } else if (req.method === "POST" && url.pathname === "/v1/user") {
        res = await handleUser(req, env);
      } else if (req.method === "POST" && url.pathname === "/v1/push/subscribe") {
        res = await handlePushSubscribe(req, env);
      } else if (req.method === "POST" && url.pathname === "/v1/push/unsubscribe") {
        res = await handlePushUnsubscribe(req, env);
      } else if (req.method === "POST" && url.pathname === "/v1/push/test") {
        res = await handlePushTest(req, env);
      } else if (req.method === "GET" && url.pathname === "/v1/version") {
        // The git SHA this worker was deployed from (set via `--var GIT_SHA` at
        // deploy; "dev" locally). CI reads it to decide whether the live worker is
        // behind HEAD on worker code, and to assert it caught up after a deploy.
        res = json({ sha: env.GIT_SHA || "dev" });
      } else if (req.method === "GET" && url.pathname === "/v1/voice-attempts") {
        res = await handleVoiceAttempts(req, env);
      } else if (req.method === "GET" && url.pathname === "/v1/native/pairs") {
        res = await handleNativePairs(req, env);
      } else if (req.method === "GET" && url.pathname.match(/^\/v1\/user\/[^/]+\/events$/)) {
        res = await handleGetEvents(req, env, url);
      } else if (req.method === "GET" && url.pathname.match(/^\/v1\/user\/[^/]+$/)) {
        res = await handleGetUser(req, env, url);
      } else if (req.method === "GET" && url.pathname === "/v1/admin/stats") {
        res = await handleAdminStats(req, env, url);
      } else if (req.method === "GET" && url.pathname === "/v1/admin/stats/users") {
        res = await handleAdminUserStats(req, env, url);
      } else if (req.method === "GET" && url.pathname === "/v1/admin/reminder") {
        res = await handleAdminReminder(req, env, url);
      } else {
        res = new Response("not found", { status: 404 });
      }
    } catch (e) {
      res = new Response("server error: " + (e && e.message), { status: 500 });
    }

    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  // Hourly cron (wrangler.toml [triggers]) → daily push reminders.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, Date.now()).catch((e) => console.error("reminders:", (e && e.message) || e)));
  },
};

// Push a reminder to every subscription whose local time is a nudge hour and
// whose events say they haven't started (19:00) / aren't done (22:00) today.
// No-op until VAPID is configured (public key committed + private key secret).
async function runReminders(env, now) {
  if (!VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  await ensureMigrated(env);
  const privateJwk = JSON.parse(env.VAPID_PRIVATE_KEY);
  const subs = ((await env.mimi_stats.prepare("SELECT * FROM push_subs").all()).results) || [];
  const since = now - 48 * 3600 * 1000;   // only today (local) can matter; 48h covers any offset

  for (const sub of subs) {
    // Skip the events query for the ~22 hours/day this device isn't near a nudge.
    const { hour } = localStamp(now, sub.tz_offset);
    if (hour !== START_HOUR && hour !== DONE_HOUR) continue;

    const events = ((await env.mimi_stats.prepare(
      "SELECT ts, target, picked, ev FROM events WHERE uid = ? AND ts >= ?"
    ).bind(sub.uid, since).all()).results) || [];
    const due = dueNudge(sub, events, now);
    if (!due) continue;

    const auth = await vapidAuth(sub.endpoint, privateJwk, VAPID_PUBLIC_KEY);
    const body = await encryptPayload(NUDGE_TEXT[due.tier], { p256dh: sub.p256dh, auth: sub.auth });
    const status = await sendPush(sub.endpoint, auth, body);
    if (status === 404 || status === 410) {
      await env.mimi_stats.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(sub.endpoint).run();
    } else {
      await env.mimi_stats.prepare("UPDATE push_subs SET last_push = ? WHERE endpoint = ?")
        .bind(due.stamp, sub.endpoint).run();
    }
  }
}

async function handleEvents(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.uid !== "string" || !Array.isArray(body.events)) {
    return new Response("bad request", { status: 400 });
  }
  if (body.events.length === 0) return json({ ok: true, count: 0 });
  if (body.events.length > 200) {
    return new Response("too many events", { status: 413 });
  }

  const insertEvent = env.mimi_stats.prepare(
    "INSERT INTO events (uid, ts, target, idx, picked, cap, ms, ev, voice, opts, skill) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const inserts = body.events.map((e) => {
    const ev = ["a", "g", "r", "p", "y", "n"].includes(e.ev) ? e.ev : "a";
    const target = String(e.target || "");
    const idx = e.idx | 0;
    const picked = String(e.picked || "");
    // idx describes "what was played in this event"; the owning mora is
    // `picked` for 'p' events and `target` otherwise. The worker resolves
    // (mora-of-played, idx) → canonical voice name from the build-time map
    // so the row preserves voice identity across voice-set changes.
    const moraOfPlayed = ev === "p" ? picked : target;
    // opts = the choice morae shown for this answer (comma-joined), so we can
    // later compute true pairwise confusion (picked when offered). Present on
    // 'a'/'g'; null otherwise.
    const opts = Array.isArray(e.opts) ? e.opts.join(",") : null;
    // skill = the target vowel's level at question time, frozen so changing the
    // level rules can't rewrite history. Present on 'a'/'g'; null otherwise.
    const skill = Number.isInteger(e.skill) ? e.skill : null;
    return insertEvent.bind(
      body.uid,
      +e.ts,            // full epoch ms; |0 truncates past 32 bits
      target,
      idx,
      picked,
      e.cap | 0,
      e.ms != null ? (e.ms | 0) : null,
      ev,
      nameOf(moraOfPlayed, idx),
      opts,
      skill,
    );
  });
  const now = Date.now();
  // tz = minutes east of UTC (client's -getTimezoneOffset()); recorded so the
  // admin knows every user's timezone, not just reminder subscribers. COALESCE so
  // an old client that omits it doesn't wipe a previously-recorded offset.
  const tz = (typeof body.tz === "number" && body.tz >= -720 && body.tz <= 840) ? Math.trunc(body.tz) : null;
  // remind_state: how the user engaged with the reminder opt-in (declined/offered;
  // null = not shown / no signal). COALESCE keeps the last known value when omitted.
  const remindState = ["declined", "offered"].includes(body.remind_state) ? body.remind_state : null;
  const userTouch = env.mimi_stats.prepare(
    "INSERT INTO users (uid, first_seen, last_seen, tz_offset, remind_state) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(uid) DO UPDATE SET last_seen = excluded.last_seen, " +
    "tz_offset = COALESCE(excluded.tz_offset, tz_offset), remind_state = COALESCE(excluded.remind_state, remind_state)"
  ).bind(body.uid, now, now, tz, remindState);

  await env.mimi_stats.batch([...inserts, userTouch]);
  return json({ ok: true, count: body.events.length });
}

async function handleGetEvents(req, env, url) {
  const uid = decodeURIComponent(url.pathname.split("/")[3]);
  const [rows, user] = await Promise.all([
    env.mimi_stats.prepare(
      "SELECT ts, target, idx, picked, cap, ms, ev, voice, opts FROM events WHERE uid = ? ORDER BY ts ASC"
    ).bind(uid).all(),
    env.mimi_stats.prepare("SELECT tz_offset FROM users WHERE uid = ?").bind(uid).first(),
  ]);
  // tz_offset (minutes east of UTC) lets the dashboard bucket this user's
  // hour-of-day in their own local time, not the viewer's. Null = not yet reported.
  return json({ events: rows.results || [], tz_offset: user ? user.tz_offset : null });
}

// Per-recording answer counts so the app can prefer the least-judged recording
// of each sound and even out the dataset. Shape: { mora: { idx: n } } over answer
// events (a/g/y/n), test users excluded. Public + uid-free (just aggregate
// counts); the client uses it best-effort. Missing (mora, idx) = 0 attempts.
async function handleVoiceAttempts(req, env) {
  const rows = ((await env.mimi_stats.prepare(
    `SELECT target AS m, idx AS i, COUNT(*) AS n
     FROM events WHERE ${ANSWER_EVS} AND ${EXCLUDE_TEST}
     GROUP BY target, idx`
  ).all()).results) || [];
  const out = {};
  for (const r of rows) (out[r.m] ||= {})[r.i] = r.n;
  return json(out);
}

// Native-tester pair ranking: which (recording, confuser) pairs to drill next.
// Computed over all non-auto-test data (role != 1, i.e. normal + native — native
// answers feed back, so pairs that confuse natives keep surfacing for others to
// validate). A recording is (mora, idx) — idx is what the client plays and what
// /v1/voice-attempts groups on, so we group on it too rather than the voice name.
// For each off-diagonal (recording, confuser kana):
//   wrong-rate = times the confuser was picked ÷ times it was offered.
// A pair is dropped once high-accuracy listeners (>90% overall) have been offered
// it ≥5 times — treated as vetted, not worth a native's time. The survivors are
// ranked by wrong-rate (random tie-break); the top 200 become a no-repeat session.
async function handleNativePairs(req, env) {
  const db = env.mimi_stats;
  const NOT_AUTO = "uid NOT IN (SELECT uid FROM users WHERE role = 1)";
  const EXPERT = `uid IN (SELECT uid FROM events WHERE ${ANSWER_EVS} AND ${NOT_AUTO}
       GROUP BY uid HAVING SUM(${CORRECT}) * 100.0 / COUNT(*) > 90)`;
  const [allRows, expertRows] = await Promise.all([
    db.prepare(
      `SELECT target AS t, idx AS i, opts AS o, picked AS p, COUNT(*) AS n
       FROM events WHERE ev IN ('a','g') AND opts IS NOT NULL AND ${NOT_AUTO}
       GROUP BY target, idx, opts, picked`
    ).all(),
    db.prepare(
      `SELECT target AS t, idx AS i, opts AS o, COUNT(*) AS n
       FROM events WHERE ev IN ('a','g') AND opts IS NOT NULL AND ${NOT_AUTO} AND ${EXPERT}
       GROUP BY target, idx, opts`
    ).all(),
  ]);
  // shown/offered over everyone; expertOffered restricted to >90% listeners.
  const shown = {}, offered = {}, expertOffered = {};
  for (const r of allRows.results || []) {
    shown[`${r.t}/${r.i}/${r.p}`] = (shown[`${r.t}/${r.i}/${r.p}`] || 0) + r.n;
    for (const k of r.o.split(",")) offered[`${r.t}/${r.i}/${k}`] = (offered[`${r.t}/${r.i}/${k}`] || 0) + r.n;
  }
  for (const r of expertRows.results || []) {
    for (const k of r.o.split(",")) expertOffered[`${r.t}/${r.i}/${k}`] = (expertOffered[`${r.t}/${r.i}/${k}`] || 0) + r.n;
  }
  const ranked = [];
  for (const key in offered) {
    const [t, i, c] = key.split("/");
    if (c === t) continue;                          // off-diagonal only (confuser ≠ recording)
    if ((expertOffered[key] || 0) >= 5) continue;   // vetted by high-accuracy listeners
    ranked.push({ mora: t, idx: +i, confuser: c, rate: (shown[key] || 0) / offered[key], offered: offered[key], wrong: shown[key] || 0, rand: Math.random() });
  }
  ranked.sort((a, b) => b.rate - a.rate || b.rand - a.rand);
  // offered/wrong (rate's denominator/numerator) ride along for debugging — the client ignores them.
  return json({ pairs: ranked.slice(0, 200).map(({ mora, idx, confuser, offered, wrong }) => ({ mora, idx, confuser, offered, wrong })) });
}

// Minimal per-user metadata. Currently just `power_user` (0/1/2) so the
// dashboard can decide whether to expose the "view another uid" form to its
// viewer (it does so only at level 2 — per-user data). Returns 0 for unknown
// uids — no auth required, no PII leaked: the flag is unguessable trivia
// about an unguessable UUID.
async function handleGetUser(req, env, url) {
  const uid = decodeURIComponent(url.pathname.split("/")[3]);
  return json({ power_user: await powerLevel(env, uid) });
}

// Read-only daily-reminder state for a uid: `on` iff it has a push subscription;
// `state` is the opt-in engagement otherwise ('declined' / 'offered' / null = never
// shown). Gated to power users (>= 1), matching the dashboard view-as it backs —
// the requester passes their own uid; ?target is the uid being inspected.
async function handleAdminReminder(req, env, url) {
  const uid = url.searchParams.get("uid") || "";
  if (await powerLevel(env, uid) < 1) {
    return new Response("forbidden", { status: 403 });
  }
  const target = url.searchParams.get("target") || "";
  const sub = await env.mimi_stats.prepare(
    "SELECT 1 FROM push_subs WHERE uid = ? LIMIT 1"
  ).bind(target).first();
  const u = await env.mimi_stats.prepare(
    "SELECT remind_state FROM users WHERE uid = ?"
  ).bind(target).first();
  return json({ on: !!sub, state: u ? u.remind_state : null });
}

async function handleUser(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.uid !== "string" || typeof body.nickname !== "string") {
    return new Response("bad request", { status: 400 });
  }
  const nickname = body.nickname.trim().slice(0, 64);
  // Optional role: 2 = native tester (self-assigned via ?nativeTester), 1 =
  // automatic test user (the e2e harness). Self-assignable — it only excludes
  // the caller's own data / changes their own mode. null = leave role unchanged
  // (a plain nickname update mustn't reset a native tester back to normal).
  const role = [0, 1, 2].includes(body.role) ? body.role : null;
  const now = Date.now();
  await env.mimi_stats.prepare(
    "INSERT INTO users (uid, nickname, role, first_seen, last_seen) VALUES (?, ?, COALESCE(?, 0), ?, ?) " +
    "ON CONFLICT(uid) DO UPDATE SET nickname = excluded.nickname, role = COALESCE(?, role), last_seen = excluded.last_seen"
  ).bind(body.uid, nickname, role, now, now, role).run();
  return json({ ok: true });
}

// Store (or refresh) a browser's Web Push subscription so the reminder cron can
// nudge it. Body: { uid, subscription: PushSubscription.toJSON(), tzOffset }.
// Keyed by endpoint — re-subscribing the same device (e.g. after a key rotation)
// updates the row rather than duplicating it.
async function handlePushSubscribe(req, env) {
  const body = await req.json().catch(() => null);
  const sub = body && body.subscription;
  const keys = sub && sub.keys;
  if (!body || typeof body.uid !== "string" || typeof body.tzOffset !== "number"
    || !sub || typeof sub.endpoint !== "string"
    || !keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    return new Response("bad request", { status: 400 });
  }
  await env.mimi_stats.prepare(
    "INSERT INTO push_subs (endpoint, uid, p256dh, auth, tz_offset, created) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(endpoint) DO UPDATE SET uid = excluded.uid, p256dh = excluded.p256dh, " +
    "auth = excluded.auth, tz_offset = excluded.tz_offset"
  ).bind(sub.endpoint, body.uid, keys.p256dh, keys.auth, body.tzOffset, Date.now()).run();
  return json({ ok: true });
}

// Drop a subscription (the user turned reminders off, or the browser replaced
// it). Body: { endpoint }. Idempotent — deleting a missing row is fine.
async function handlePushUnsubscribe(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.endpoint !== "string") return new Response("bad request", { status: 400 });
  await env.mimi_stats.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(body.endpoint).run();
  return json({ ok: true });
}

// Send a push to one subscription right now — the ?remind=test delivery check.
// Body: { endpoint }. 503 if VAPID isn't configured, 404 if the endpoint isn't a
// known subscription.
async function handlePushTest(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.endpoint !== "string") return new Response("bad request", { status: 400 });
  if (!VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return new Response("push not configured", { status: 503 });
  const sub = await env.mimi_stats.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE endpoint = ?").bind(body.endpoint).first();
  if (!sub) return new Response("unknown subscription", { status: 404 });
  const auth = await vapidAuth(sub.endpoint, JSON.parse(env.VAPID_PRIVATE_KEY), VAPID_PUBLIC_KEY);
  const payload = await encryptPayload("Reminders are on — this is a test nudge. ✔", { p256dh: sub.p256dh, auth: sub.auth });
  const status = await sendPush(sub.endpoint, auth, payload);
  return json({ ok: status >= 200 && status < 300, status });
}

// Sound / aggregate stats — the level-1 admin tier. Auth is "you-know-the-uid":
// the requester passes their own uid via ?uid=… and we check power_user >= 1.
// Everything here is aggregated across all users with no device identifiers,
// so it's the safe-to-share-wider tier. Random UUIDs are unguessable in
// practice, matching the rest of the worker's soft-auth model.
async function handleAdminStats(req, env, url) {
  const uid = url.searchParams.get("uid") || "";
  if (await powerLevel(env, uid) < 1) {
    return new Response("forbidden", { status: 403 });
  }

  const db = env.mimi_stats;

  // ?minacc=N (0..100): drop the confusion matrices' data from users whose overall
  // correct rate is below N%, so noise from users who answer near-randomly doesn't
  // muddy the confusion signal. Parsed to a clamped integer, so it's safe to inline.
  // Only the confusion aggregations honour it (the difficulty/activity ones don't).
  const minacc = Math.max(0, Math.min(100, parseInt(url.searchParams.get("minacc"), 10) || 0));

  // ?natives=1 switches the confusion matrices to the native testers (role 2)
  // instead of normal users (role 0) — to review what genuinely confuses natives,
  // exclusive of each other. Only the confusion aggregations honour it; the
  // activity/difficulty sections always reflect normal users.
  const POP = url.searchParams.get("natives") === "1"
    ? "uid IN (SELECT uid FROM users WHERE role = 2)"
    : EXCLUDE_TEST;

  const ACC_FILTER = minacc > 0
    ? `AND uid IN (SELECT uid FROM events WHERE ${ANSWER_EVS} AND ${POP}
         GROUP BY uid HAVING SUM(${CORRECT}) * 100.0 / COUNT(*) >= ${minacc})`
    : "";

  // Overview window bounds for the active-user counts.
  const now = Date.now();
  const d7 = now - 7 * 86400000;
  const d30 = now - 30 * 86400000;

  // Parallel aggregations. Each scans/groups the events table on indexed
  // columns; on the current data size (~thousands of rows) this is sub-second.
  // Add caching here if events grows several orders of magnitude.
  const [hourly, byMora, optsConf, ynConf, byVoiceOpts, totals, active] = await Promise.all([
    db.prepare(
      `SELECT CAST(strftime('%H', ts/1000, 'unixepoch') AS INTEGER) AS h,
              COUNT(*) AS n,
              SUM(${CORRECT}) AS correct
       FROM events WHERE ${ANSWER_EVS} AND ${EXCLUDE_TEST}
       GROUP BY h ORDER BY h`
    ).all(),
    db.prepare(
      `SELECT target AS m,
              COUNT(*) AS n,
              SUM(${CORRECT}) AS correct
       FROM events WHERE ${ANSWER_EVS} AND ${EXCLUDE_TEST}
       GROUP BY target`
    ).all(),
    // Pairwise "when offered" confusion source: group by the choice set so we
    // can normalise a confuser by how often it was actually on screen, not by
    // how often the sound was asked. SQLite can't unnest the comma-joined opts,
    // so we expand it in JS below. opts is null on pre-migration / 'r' / 'p'.
    db.prepare(
      `SELECT target AS t, opts AS o, picked AS p, COUNT(*) AS n
       FROM events WHERE ev IN ('a','g') AND opts IS NOT NULL AND ${POP} ${ACC_FILTER}
       GROUP BY target, opts, picked`
    ).all(),
    // Y/N answers have no offered set; we synthesise one per (target, picked, ev)
    // group in JS below (confusionRecord), the same mapping the dashboard uses.
    db.prepare(
      `SELECT target AS t, picked AS p, ev AS e, COUNT(*) AS n
       FROM events WHERE ev IN ('y','n') AND ${POP} ${ACC_FILTER}
       GROUP BY target, picked, ev`
    ).all(),
    // Same "when offered" expansion as optsConf, but per recording (target,
    // voice) — so the sound-file confusion matrix can normalise a confuser by how
    // often that kana was offered for this recording, not by how often the
    // recording was asked. Expanded in JS below.
    db.prepare(
      `SELECT target AS t, voice AS v, opts AS o, picked AS p, COUNT(*) AS n
       FROM events WHERE ev IN ('a','g') AND opts IS NOT NULL AND voice IS NOT NULL AND ${POP} ${ACC_FILTER}
       GROUP BY target, voice, opts, picked`
    ).all(),
    // Overview counters — app-wide aggregates with no device identifiers, so they
    // belong to this level-1 tier. `days` = distinct UTC days with any answer (the
    // overview's "days of data"). Always normal users (EXCLUDE_TEST), like the
    // difficulty/activity sections — never gated by minacc/natives.
    db.prepare(
      `SELECT COUNT(*)                                                       AS events,
              COUNT(DISTINCT uid)                                            AS users,
              SUM(CASE WHEN ${ANSWER_EVS} THEN 1 ELSE 0 END)                 AS answers,
              SUM(CASE WHEN ${ANSWER_EVS} AND (${CORRECT}) THEN 1 ELSE 0 END) AS correct,
              SUM(CASE WHEN ev = 'r' THEN 1 ELSE 0 END)                      AS relisten,
              COUNT(DISTINCT CASE WHEN ${ANSWER_EVS} THEN date(ts/1000, 'unixepoch') END) AS days
       FROM events WHERE ${EXCLUDE_TEST}`
    ).first(),
    db.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT uid) FROM events WHERE ts > ? AND ${EXCLUDE_TEST}) AS d7,
         (SELECT COUNT(DISTINCT uid) FROM events WHERE ts > ? AND ${EXCLUDE_TEST}) AS d30`
    ).bind(d7, d30).first(),
  ]);

  // Expand the grouped opts sets into pairwise counts: offered[t/k] = times kana
  // k was on screen when t was asked; shown[t/p] = times p was picked among those
  // (p is always in opts, so shown <= offered and the ratio stays in [0,1]).
  const offered = {}, shown = {};
  for (const r of optsConf.results || []) {
    shown[`${r.t}/${r.p}`] = (shown[`${r.t}/${r.p}`] || 0) + r.n;
    for (const k of r.o.split(",")) offered[`${r.t}/${k}`] = (offered[`${r.t}/${k}`] || 0) + r.n;
  }

  // Fold Y/N answers in via the shared synthesis (same mapping as the dashboard):
  // each (target, picked, ev) group lands on the diagonal, and a wrong-kana prompt
  // also on the confuser. Scales each synthesised pick by the group's row count.
  for (const r of ynConf.results || []) {
    const rec = confusionRecord({ ev: r.e, target: r.t, picked: r.p });
    if (!rec) continue;
    shown[`${rec.target}/${rec.picked}`] = (shown[`${rec.target}/${rec.picked}`] || 0) + r.n;
    for (const k of rec.opts) offered[`${rec.target}/${k}`] = (offered[`${rec.target}/${k}`] || 0) + r.n;
  }

  // Per-recording version of the same: vShown[t/v/p] = picks of p when (t,v) was
  // the question; vOffered[t/v/k] = times k was offered for it. (Voice names carry
  // no "/", so the 3-part key splits cleanly.)
  const vOffered = {}, vShown = {};
  for (const r of byVoiceOpts.results || []) {
    vShown[`${r.t}/${r.v}/${r.p}`] = (vShown[`${r.t}/${r.v}/${r.p}`] || 0) + r.n;
    for (const k of r.o.split(",")) vOffered[`${r.t}/${r.v}/${k}`] = (vOffered[`${r.t}/${r.v}/${k}`] || 0) + r.n;
  }

  const rowsOf = (m, key) => Object.entries(m).map(([pair, n]) => {
    const [t, x] = pair.split("/");
    return { t, [key]: x, n };
  });
  const rowsOf3 = (m, key) => Object.entries(m).map(([k, n]) => {
    const [t, v, x] = k.split("/");
    return { t, v, [key]: x, n };
  });

  return json({
    totals,
    active,
    hourly:    hourly.results     || [],
    by_mora:   byMora.results     || [],
    confusion_shown:   rowsOf(shown, "p"),
    confusion_offered: rowsOf(offered, "k"),
    by_voice_shown:     rowsOf3(vShown, "p"),
    by_voice_offered:   rowsOf3(vOffered, "k"),
  });
}

// Per-user / uid-drilldown stats — the level-2 admin tier. Same soft-auth as
// above but gated at power_user >= 2, because everything here carries device
// identifiers (per-bucket uid lists, the daily-activity uid map, nicknames). The
// identifier-free overview counters live one tier down on /v1/admin/stats. A
// level-1 power user gets 403 here even though they can read /v1/admin/stats —
// that's the access split.
async function handleAdminUserStats(req, env, url) {
  const uid = url.searchParams.get("uid") || "";
  if (await powerLevel(env, uid) < 2) {
    return new Response("forbidden", { status: 403 });
  }

  const db = env.mimi_stats;

  const [daily, skillStream, nicks, dailyUidRows, userTzRows, tzRows] = await Promise.all([
    db.prepare(
      `SELECT date(ts/1000, 'unixepoch') AS d,
              COUNT(*) AS n,
              SUM(${CORRECT}) AS correct
       FROM events WHERE ${ANSWER_EVS} AND ${EXCLUDE_TEST}
       GROUP BY d ORDER BY d`
    ).all(),
    // Raw event stream for per-user skill replay. Cheaper than expressing
    // the streak/decay rules in pure SQL. ORDER BY uid keeps each user's
    // sequence contiguous so the JS loop below can compute incrementally.
    db.prepare(
      `SELECT uid, ts, target, picked, ev FROM events
       WHERE (${ANSWER_EVS} OR ev = 'r') AND ${EXCLUDE_TEST}
       ORDER BY uid, ts ASC`
    ).all(),
    // User-set nicknames. Emitted as a flat uid→nickname map so the admin
    // frontend can annotate the uid-drill-down popups without a second round
    // trip. EXCLUDE_TEST keeps the seed fixture out.
    db.prepare(
      `SELECT uid, nickname FROM users
       WHERE nickname IS NOT NULL AND nickname != '' AND ${EXCLUDE_TEST}`
    ).all(),
    // (date, uid) pairs for the daily-activity bar drill-down. One row per
    // user who answered something that day — JS folds it into a {date: [uid]}
    // map for the popup.
    db.prepare(
      `SELECT date(ts/1000, 'unixepoch') AS d, uid
       FROM events WHERE ${ANSWER_EVS} AND ${EXCLUDE_TEST}
       GROUP BY d, uid`
    ).all(),
    // uid → timezone offset (minutes east of UTC). Primary source: users.tz_offset
    // (reported on every events POST — covers all users). push_subs.tz_offset is a
    // fallback for users who subscribed but haven't been active since it shipped.
    db.prepare(
      `SELECT uid, tz_offset FROM users
       WHERE tz_offset IS NOT NULL AND ${EXCLUDE_TEST}`
    ).all(),
    db.prepare(
      `SELECT uid, tz_offset FROM push_subs
       WHERE tz_offset IS NOT NULL AND ${EXCLUDE_TEST}
       GROUP BY uid`
    ).all(),
  ]);

  // Replay the skill-state machine per user to derive each user's current
  // per-vowel skill. Rules live in src/shared/skill.js, shared with app + dashboard.
  const perUser = {};
  const userAnswers = {};   // per-user count of answer events (a/g/y/n)
  const userDays = {};      // per-user set of YYYY-MM-DD strings (UTC) seen
  for (const e of skillStream.results || []) {
    const v = e.target.slice(-1);
    const cur = perUser[e.uid] || (perUser[e.uid] = {});
    const c = cur[v] || 0;
    if (isAnswerEv(e.ev)) {
      userAnswers[e.uid] = (userAnswers[e.uid] || 0) + 1;
      const day = new Date(e.ts).toISOString().slice(0, 10);
      (userDays[e.uid] = userDays[e.uid] || new Set()).add(day);
      cur[v] = answeredRight(e) ? onCorrect(c) : onWrong(c);
    } else {
      cur[v] = onRelisten(c);   // 'r' — drop to the start of the current level
    }
  }

  // Bucket each user's per-vowel skill into level bins (0..4). Users who
  // never trained a given vowel don't contribute to that vowel's histogram.
  // For each histogram we also emit a parallel array of per-bucket uid
  // lists so the admin frontend can pop up the contributing devices on
  // bar click. Cheap at current scale: ~36 B/uid per bucket they land in.
  const mkBuckets = (n) => Array.from({ length: n }, () => []);
  const level_hist = { a: [0, 0, 0, 0, 0], i: [0, 0, 0, 0, 0], u: [0, 0, 0, 0, 0], o: [0, 0, 0, 0, 0] };
  const level_hist_uids = { a: mkBuckets(5), i: mkBuckets(5), u: mkBuckets(5), o: mkBuckets(5) };
  for (const uid in perUser) {
    for (const v of ["a", "i", "u", "o"]) {
      if (perUser[uid][v] === undefined) continue;
      const bin = levelIdx(perUser[uid][v]) + 1;
      level_hist[v][bin]++;
      level_hist_uids[v][bin].push(uid);
    }
  }

  // 8 ~3×-stepped buckets for total answers — wider than log2, finer than
  // log10. Max bucket covers anyone above ~3000 answers (practical ceiling).
  const activity_hist = new Array(8).fill(0);
  const activity_hist_uids = mkBuckets(8);
  for (const uid in userAnswers) {
    const a = userAnswers[uid];
    const b = a < 4 ? 0 : a < 10 ? 1 : a < 30 ? 2 : a < 100 ? 3 : a < 300 ? 4 : a < 1000 ? 5 : a < 3000 ? 6 : 7;
    activity_hist[b]++;
    activity_hist_uids[b].push(uid);
  }

  // One bucket per day-count from 1..30 plus a "30+" overflow bucket.
  const days_hist = new Array(31).fill(0);
  const days_hist_uids = mkBuckets(31);
  for (const uid in userDays) {
    const d = userDays[uid].size;
    if (d <= 0) continue;
    const bin = Math.min(30, d - 1);
    days_hist[bin]++;
    days_hist_uids[bin].push(uid);
  }

  return json({
    daily: daily.results || [],
    level_hist,
    level_hist_uids,
    activity_hist,
    activity_hist_uids,
    days_hist,
    days_hist_uids,
    nicknames: Object.fromEntries((nicks.results || []).map((r) => [r.uid, r.nickname])),
    // push_subs as fallback, users.tz_offset (authoritative, all users) overlaid on top.
    timezones: {
      ...Object.fromEntries((tzRows.results || []).map((r) => [r.uid, r.tz_offset])),
      ...Object.fromEntries((userTzRows.results || []).map((r) => [r.uid, r.tz_offset])),
    },
    daily_uids: (dailyUidRows.results || []).reduce((m, r) => {
      (m[r.d] = m[r.d] || []).push(r.uid);
      return m;
    }, {}),
  });
}
