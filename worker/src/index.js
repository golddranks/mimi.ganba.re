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
import { isAnswerEv, answeredRight, isPenalizedRelisten } from "../../src/shared/events.js";
import { VOWEL_GROUPS } from "../../src/shared/kana.js";
import { VAPID_PUBLIC_KEY } from "../../src/shared/vapid.js";
import { localStamp, dueNudge, vapidAuth, encryptPayload, sendPush, NUDGE_TEXT, START_HOUR, DONE_HOUR } from "./push.js";

// The /stats/ confusion matrices and difficult-kana table show only normal users
// (role 0): natives (role 2) do forced-pair drilling that would skew those
// signals, and e2e/seed bots (role 1) are pure noise. uids with no users row
// (shouldn't happen; every event POST upserts one) count as normal.
// SQL-injection note: hard-coded fragment, never user-input. Related predicates:
// the natives toggle (role 0 XOR role 2) on the confusion matrices, and
// EXCLUDE_AUTO below.
const EXCLUDE_TEST = "uid NOT IN (SELECT uid FROM users WHERE role != 0)";
// Keeps natives (role 2) in — only the automatic e2e/seed bots (role 1) are
// excluded. The admin user-stats page and the native pair-ranking use this:
// natives are real humans whose activity belongs in those views (the role-0-only
// exclusion was only ever meant for the /stats/ confusion + difficulty signals).
const EXCLUDE_AUTO = "uid NOT IN (SELECT uid FROM users WHERE role = 1)";

// SQL mirror of src/shared/events.js: which events are answers, and the 1/0
// "answered right" expression (the Y/N "no" inverts — right when picked != target).
// Kept here as fragments so the answer/accuracy aggregates below stay in step with
// the JS the dashboard and push use. Hard-coded, never user input.
const ANSWER_EVS = "ev IN ('a','g','y','n')";
const CORRECT = "CASE WHEN ev = 'n' THEN picked <> target ELSE picked = target END";
const DAY_MS = 86400000;
// Validate a reported tz offset (minutes east of UTC, -720..+840) → int or null.
const tzOf = (v) => (typeof v === "number" && v >= -720 && v <= 840) ? Math.trunc(v) : null;

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

  // Hourly cron (wrangler.toml [triggers]) → daily push reminders + the janitor.
  async scheduled(event, env, ctx) {
    const now = Date.now();
    ctx.waitUntil(runReminders(env, now).catch((e) => console.error("reminders:", (e && e.message) || e)));
    ctx.waitUntil(runJanitor(env, now).catch((e) => console.error("janitor:", (e && e.message) || e)));
  },
};

// Janitor (runs on the hourly cron): purge automatic e2e test users (role 1) and
// their data. They're created by the post-deploy verify suite hitting prod, are
// excluded from every aggregate, and have no lasting value. Age-gate on last_seen
// so an in-flight verify run — which posts a test user then immediately reads it
// back — is never deleted mid-pass; an hour dwarfs a verify pass.
async function runJanitor(env, now) {
  const cutoff = now - 60 * 60 * 1000;   // role-1 users idle > 1h
  const stale = "uid IN (SELECT uid FROM users WHERE role = 1 AND last_seen < ?)";
  // events + push_subs reference the rows, so clear them before the users themselves.
  await env.mimi_stats.batch([
    env.mimi_stats.prepare(`DELETE FROM events WHERE ${stale}`).bind(cutoff),
    env.mimi_stats.prepare(`DELETE FROM push_subs WHERE ${stale}`).bind(cutoff),
    env.mimi_stats.prepare("DELETE FROM users WHERE role = 1 AND last_seen < ?").bind(cutoff),
  ]);
}

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
      "SELECT ts, target, picked, ev, cap FROM events WHERE uid = ? AND ts >= ?"
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
    "INSERT INTO events (uid, ts, target, idx, picked, cap, ms, ev, voice, opts, skill, start_ts) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
      e.start_ts != null ? +e.start_ts : null,   // the question's start; an exact per-question key
    );
  });
  const now = Date.now();
  // tz = minutes east of UTC (client's -getTimezoneOffset()); recorded so the
  // admin knows every user's timezone, not just reminder subscribers. COALESCE so
  // an old client that omits it doesn't wipe a previously-recorded offset.
  const tz = tzOf(body.tz);
  // remind_state: how the user engaged with the reminder opt-in (declined/offered;
  // null = not shown / no signal). COALESCE keeps the last known value when omitted.
  const remindState = ["declined", "offered"].includes(body.remind_state) ? body.remind_state : null;
  const userTouch = env.mimi_stats.prepare(
    "INSERT INTO users (uid, first_seen, last_seen, tz_offset, remind_state) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(uid) DO UPDATE SET last_seen = excluded.last_seen, " +
    "tz_offset = COALESCE(excluded.tz_offset, tz_offset), remind_state = COALESCE(excluded.remind_state, remind_state)"
  ).bind(body.uid, now, now, tz, remindState);

  // Recompute this user's delete_after (retention horizon) here — the one place its
  // inputs change. max of two arms, each = 30 days + 1 day per 10 answers, anchored on:
  //   first_seen — a lifetime-loyalty floor (total answers; a fixed date that expires), and
  //   last_seen  — recency (answers in the trailing 30 days; extends with each visit).
  // So engaged/recent users keep their history longer, but an idle user always
  // expires (both arms become fixed). Runs after the inserts above, so the counts
  // include this batch. Answer events are a/g/y/n (ANSWER_EVS).
  const deleteAfter = env.mimi_stats.prepare(
    `UPDATE users SET delete_after = MAX(
       first_seen + ${30 * DAY_MS} + (SELECT COUNT(*) FROM events e WHERE e.uid = users.uid AND ${ANSWER_EVS}) * ${DAY_MS / 10},
       last_seen  + ${30 * DAY_MS} + (SELECT COUNT(*) FROM events e WHERE e.uid = users.uid AND ${ANSWER_EVS} AND e.ts >= users.last_seen - ${30 * DAY_MS}) * ${DAY_MS / 10})
     WHERE uid = ?`
  ).bind(body.uid);

  await env.mimi_stats.batch([...inserts, userTouch, deleteAfter]);
  return json({ ok: true, count: body.events.length });
}

async function handleGetEvents(req, env, url) {
  const uid = decodeURIComponent(url.pathname.split("/")[3]);
  const [rows, user] = await Promise.all([
    env.mimi_stats.prepare(
      "SELECT ts, target, idx, picked, cap, ms, ev, voice, opts, start_ts FROM events WHERE uid = ? ORDER BY ts ASC"
    ).bind(uid).all(),
    env.mimi_stats.prepare("SELECT tz_offset, delete_after, role FROM users WHERE uid = ?").bind(uid).first(),
  ]);
  // tz_offset (minutes east of UTC) lets the dashboard bucket this user's hour-of-day
  // in their own local time; delete_after is the retention horizon shown on the
  // dashboard; role surfaces the native-testing badge (role 2). All null only for a
  // user with no row yet.
  return json({
    events: rows.results || [],
    tz_offset: user ? user.tz_offset : null,
    delete_after: user ? user.delete_after : null,
    role: user ? user.role : null,
  });
}

// Per-recording confusion-matrix coverage so the app can prefer the recordings
// the matrix still lacks data for, evening the dataset out. Shape: { mora: { idx:
// n } }, where n is NOT the total answers but the *minimum* over the recording's
// same-vowel confuser pairings of how often that confuser was offered alongside
// it — because the sound-file matrix needs every (recording, confuser) cell
// filled, and a recording sampled heavily overall is still useless to a cell it
// was never offered against. A confuser never offered with the recording counts
// as 0, so it drops the min to 0. Only matrix-usable answers count: multi-choice
// (a/g) that recorded their offered set (opts) — Y/N and pre-migration rows have
// no opts and can't feed the matrix. Test users excluded; public + uid-free; the
// client uses it best-effort. Missing (mora, idx) = 0 attempts.
async function handleVoiceAttempts(req, env) {
  const rows = ((await env.mimi_stats.prepare(
    `SELECT target AS m, idx AS i, opts AS o, COUNT(*) AS n
     FROM events WHERE ev IN ('a','g') AND opts IS NOT NULL AND idx IS NOT NULL AND ${EXCLUDE_TEST}
     GROUP BY target, idx, opts`
  ).all()).results) || [];
  // offered[mora][idx][k] = times confuser k was on screen when this recording
  // was answered (summed across the distinct opts sets it appeared in).
  const offered = {};
  for (const r of rows) {
    const byIdx = offered[r.m] ||= {};
    const byK = byIdx[r.i] ||= {};
    for (const k of r.o.split(",")) byK[k] = (byK[k] || 0) + r.n;
  }
  const out = {};
  for (const m in offered) {
    // Confusers = the target's same-vowel siblings (the only kana ever offered as
    // distractors; see the app's option generator). A missing one is 0, dragging
    // the min down — exactly the gap we want the client to go fill.
    const confusers = (VOWEL_GROUPS[m.slice(-1)] || []).filter((k) => k !== m);
    for (const i in offered[m]) {
      const byK = offered[m][i];
      (out[m] ||= {})[i] = confusers.length
        ? Math.min(...confusers.map((k) => byK[k] || 0))
        : Object.values(byK).reduce((a, b) => a + b, 0);   // no siblings: fall back to total
    }
  }
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
  const EXPERT = `uid IN (SELECT uid FROM events WHERE ${ANSWER_EVS} AND ${EXCLUDE_AUTO}
       GROUP BY uid HAVING SUM(${CORRECT}) * 100.0 / COUNT(*) > 90)`;
  const [allRows, expertRows] = await Promise.all([
    db.prepare(
      `SELECT target AS t, idx AS i, opts AS o, picked AS p, COUNT(*) AS n
       FROM events WHERE ev IN ('a','g') AND opts IS NOT NULL AND ${EXCLUDE_AUTO}
       GROUP BY target, idx, opts, picked`
    ).all(),
    db.prepare(
      `SELECT target AS t, idx AS i, opts AS o, COUNT(*) AS n
       FROM events WHERE ev IN ('a','g') AND opts IS NOT NULL AND ${EXCLUDE_AUTO} AND ${EXPERT}
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
  const tz = tzOf(body.tz);   // capture tz at registration too, so a register-only user (e.g. a native tester who hasn't answered) still has one
  const now = Date.now();
  // delete_after baseline (+30d) for a brand-new register-only user (e.g. a native
  // tester who hasn't answered yet); a later events POST recomputes it in full.
  // Left untouched on conflict — the events path owns it once they've trained.
  await env.mimi_stats.prepare(
    "INSERT INTO users (uid, nickname, role, first_seen, last_seen, tz_offset, delete_after) VALUES (?, ?, COALESCE(?, 0), ?, ?, ?, ?) " +
    "ON CONFLICT(uid) DO UPDATE SET nickname = excluded.nickname, role = COALESCE(?, role), last_seen = excluded.last_seen, tz_offset = COALESCE(excluded.tz_offset, tz_offset)"
  ).bind(body.uid, nickname, role, now, now, tz, now + 30 * DAY_MS, role).run();
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
  const [hourly, byMora, optsConf, ynConf, byVoiceOpts, totals, active,
         apConf, apVoice, relConf, relVoice, slowConf, slowVoice] = await Promise.all([
    db.prepare(
      // Hour-of-day in each user's *own* local time: shift the timestamp by their
      // tz_offset (minutes east of UTC) before bucketing, defaulting to JST (540)
      // for users with none on record. So the aggregate shows when people train in
      // their own day, not against one wall clock. (u.role = 0 = EXCLUDE_TEST, but
      // unambiguous now that uid is in two joined tables.)
      `SELECT CAST(strftime('%H', (e.ts + COALESCE(u.tz_offset, 540) * 60000) / 1000, 'unixepoch') AS INTEGER) AS h,
              COUNT(*) AS n,
              SUM(${CORRECT}) AS correct
       FROM events e JOIN users u ON u.uid = e.uid
       WHERE ${ANSWER_EVS} AND u.role = 0
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
      `SELECT target AS t, opts AS o, picked AS p, ev AS e, COUNT(*) AS n
       FROM events WHERE ev IN ('a','g') AND opts IS NOT NULL AND ${POP} ${ACC_FILTER}
       GROUP BY target, opts, picked, ev`
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
      `SELECT target AS t, voice AS v, opts AS o, picked AS p, ev AS e, COUNT(*) AS n
       FROM events WHERE ev IN ('a','g') AND opts IS NOT NULL AND voice IS NOT NULL AND ${POP} ${ACC_FILTER}
       GROUP BY target, voice, opts, picked, ev`
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
    // ---- the alternate confusion metrics (the server-side mirror of confusionExtras,
    // for the /stats/ metric switch). Each shares the answered `offered` denominator,
    // except re-listen, which has its own (every question that offered the kana). ----
    // after-played: a choice replayed during review (ev 'p'); picked = the kana tapped.
    db.prepare(
      `SELECT target AS t, picked AS p, COUNT(*) AS n
       FROM events WHERE ev = 'p' AND ${POP} ${ACC_FILTER}
       GROUP BY target, picked`
    ).all(),
    // after-played per recording: a 'p' row's own voice is the *tapped* kana's, so
    // join to the question's a/g event (same uid/target/start_ts) for its recording.
    db.prepare(
      `SELECT a.target AS t, a.voice AS v, pp.picked AS p, COUNT(*) AS n
       FROM (SELECT uid, target, start_ts, picked FROM events
             WHERE ev = 'p' AND start_ts IS NOT NULL AND ${POP} ${ACC_FILTER}) pp
       JOIN events a ON a.uid = pp.uid AND a.target = pp.target AND a.start_ts = pp.start_ts
                    AND a.ev IN ('a','g') AND a.voice IS NOT NULL
       GROUP BY a.target, a.voice, pp.picked`
    ).all(),
    // re-listen: per question (uid,target,start_ts), whether it was re-listened (rel)
    // and the offered set; tot = every question offering the kana (the denominator).
    // opts/voice are constant per question, taken via MAX (voice from a/g/r — not the
    // tapped 'p' voice). Y/N questions carry no opts, so they drop out (o IS NOT NULL).
    db.prepare(
      `SELECT t, o, SUM(had_r) AS rel, COUNT(*) AS tot FROM (
         SELECT target AS t, MAX(opts) AS o,
                MAX(CASE WHEN ev = 'r' THEN 1 ELSE 0 END) AS had_r
         FROM events WHERE start_ts IS NOT NULL AND ev IN ('a','g','r','p') AND ${POP} ${ACC_FILTER}
         GROUP BY uid, target, start_ts
       ) WHERE o IS NOT NULL GROUP BY t, o`
    ).all(),
    db.prepare(
      `SELECT t, v, o, SUM(had_r) AS rel, COUNT(*) AS tot FROM (
         SELECT target AS t, MAX(opts) AS o,
                MAX(CASE WHEN ev IN ('a','g','r') THEN voice END) AS v,
                MAX(CASE WHEN ev = 'r' THEN 1 ELSE 0 END) AS had_r
         FROM events WHERE start_ts IS NOT NULL AND ev IN ('a','g','r','p') AND ${POP} ${ACC_FILTER}
         GROUP BY uid, target, start_ts
       ) WHERE o IS NOT NULL AND v IS NOT NULL GROUP BY t, v, o`
    ).all(),
    // slow: each user's slowest engaged reactions (<6s) at/above their 96th percentile
    // (PERCENT_RANK per user) — approximates the dashboard's exact nearest-rank.
    db.prepare(
      `SELECT t, p, COUNT(*) AS n FROM (
         SELECT target AS t, picked AS p,
                PERCENT_RANK() OVER (PARTITION BY uid ORDER BY ms) AS pr
         FROM events WHERE ev IN ('a','g') AND ms > 0 AND ms < 6000 AND ${POP} ${ACC_FILTER}
       ) WHERE pr >= 0.96 GROUP BY t, p`
    ).all(),
    db.prepare(
      `SELECT t, v, p, COUNT(*) AS n FROM (
         SELECT target AS t, voice AS v, picked AS p,
                PERCENT_RANK() OVER (PARTITION BY uid ORDER BY ms) AS pr
         FROM events WHERE ev IN ('a','g') AND voice IS NOT NULL AND ms > 0 AND ms < 6000 AND ${POP} ${ACC_FILTER}
       ) WHERE pr >= 0.96 GROUP BY t, v, p`
    ).all(),
  ]);

  // Expand the grouped opts sets into pairwise counts: offered[t/k] = times kana
  // k was on screen when t was asked; shown[t/p] = times p was picked among those
  // (p is always in opts, so shown <= offered and the ratio stays in [0,1]).
  const offered = {}, shown = {}, guessed = {}, afterplayed = {}, relistened = {}, relistenedOffered = {}, slow = {};
  for (const r of optsConf.results || []) {
    shown[`${r.t}/${r.p}`] = (shown[`${r.t}/${r.p}`] || 0) + r.n;            // answered = a + g
    if (r.e === "g") guessed[`${r.t}/${r.p}`] = (guessed[`${r.t}/${r.p}`] || 0) + r.n;
    for (const k of r.o.split(",")) offered[`${r.t}/${k}`] = (offered[`${r.t}/${k}`] || 0) + r.n;
  }

  // Fold Y/N answers into answered/offered only (Y/N has no g/p, and its 'r' carries
  // no choice set — so it can't enter guessed/after-played/re-listened/slow): each
  // (target, picked, ev) group lands on the diagonal, a wrong-kana prompt also on the
  // confuser, scaled by the group's row count.
  for (const r of ynConf.results || []) {
    const rec = confusionRecord({ ev: r.e, target: r.t, picked: r.p });
    if (!rec) continue;
    shown[`${rec.target}/${rec.picked}`] = (shown[`${rec.target}/${rec.picked}`] || 0) + r.n;
    for (const k of rec.opts) offered[`${rec.target}/${k}`] = (offered[`${rec.target}/${k}`] || 0) + r.n;
  }

  // Alternate metrics (mirror confusionExtras): after-played / slow are picks like
  // shown; re-listen credits every offered kana of a re-listened question (rel) over
  // a denominator of all questions offering it (tot).
  for (const r of apConf.results || []) afterplayed[`${r.t}/${r.p}`] = (afterplayed[`${r.t}/${r.p}`] || 0) + r.n;
  for (const r of slowConf.results || []) slow[`${r.t}/${r.p}`] = (slow[`${r.t}/${r.p}`] || 0) + r.n;
  for (const r of relConf.results || []) for (const k of r.o.split(",")) {
    relistenedOffered[`${r.t}/${k}`] = (relistenedOffered[`${r.t}/${k}`] || 0) + r.tot;
    if (r.rel) relistened[`${r.t}/${k}`] = (relistened[`${r.t}/${k}`] || 0) + r.rel;
  }

  // Per-recording (t,v,…) versions of all of the above. (Voice names carry no "/",
  // so the 3-part key splits cleanly.)
  const vOffered = {}, vShown = {}, vGuessed = {}, vAfterplayed = {}, vRelistened = {}, vRelistenedOffered = {}, vSlow = {};
  for (const r of byVoiceOpts.results || []) {
    vShown[`${r.t}/${r.v}/${r.p}`] = (vShown[`${r.t}/${r.v}/${r.p}`] || 0) + r.n;
    if (r.e === "g") vGuessed[`${r.t}/${r.v}/${r.p}`] = (vGuessed[`${r.t}/${r.v}/${r.p}`] || 0) + r.n;
    for (const k of r.o.split(",")) vOffered[`${r.t}/${r.v}/${k}`] = (vOffered[`${r.t}/${r.v}/${k}`] || 0) + r.n;
  }
  for (const r of apVoice.results || []) vAfterplayed[`${r.t}/${r.v}/${r.p}`] = (vAfterplayed[`${r.t}/${r.v}/${r.p}`] || 0) + r.n;
  for (const r of slowVoice.results || []) vSlow[`${r.t}/${r.v}/${r.p}`] = (vSlow[`${r.t}/${r.v}/${r.p}`] || 0) + r.n;
  for (const r of relVoice.results || []) for (const k of r.o.split(",")) {
    vRelistenedOffered[`${r.t}/${r.v}/${k}`] = (vRelistenedOffered[`${r.t}/${r.v}/${k}`] || 0) + r.tot;
    if (r.rel) vRelistened[`${r.t}/${r.v}/${k}`] = (vRelistened[`${r.t}/${r.v}/${k}`] || 0) + r.rel;
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
    confusion_shown:              rowsOf(shown, "p"),
    confusion_offered:            rowsOf(offered, "k"),
    confusion_guessed:            rowsOf(guessed, "p"),
    confusion_afterplayed:        rowsOf(afterplayed, "p"),
    confusion_relistened:         rowsOf(relistened, "k"),
    confusion_relistened_offered: rowsOf(relistenedOffered, "k"),
    confusion_slow:               rowsOf(slow, "p"),
    by_voice_shown:               rowsOf3(vShown, "p"),
    by_voice_offered:             rowsOf3(vOffered, "k"),
    by_voice_guessed:             rowsOf3(vGuessed, "p"),
    by_voice_afterplayed:         rowsOf3(vAfterplayed, "p"),
    by_voice_relistened:          rowsOf3(vRelistened, "k"),
    by_voice_relistened_offered:  rowsOf3(vRelistenedOffered, "k"),
    by_voice_slow:                rowsOf3(vSlow, "p"),
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
    // Daily activity bucketed in each user's own local day (shift ts by their
    // tz_offset, JST 540 default), so a late-night JST session counts under the
    // right calendar day — matching the user's own done/not-done frame.
    db.prepare(
      `SELECT date((e.ts + COALESCE(u.tz_offset, 540) * 60000) / 1000, 'unixepoch') AS d,
              COUNT(*) AS n,
              SUM(${CORRECT}) AS correct
       FROM events e JOIN users u ON u.uid = e.uid
       WHERE ${ANSWER_EVS} AND u.role != 1
       GROUP BY d ORDER BY d`
    ).all(),
    // Raw event stream for per-user skill replay. Cheaper than expressing
    // the streak/decay rules in pure SQL. ORDER BY uid keeps each user's
    // sequence contiguous so the JS loop below can compute incrementally.
    db.prepare(
      `SELECT uid, ts, target, picked, ev, cap FROM events
       WHERE (${ANSWER_EVS} OR ev = 'r') AND ${EXCLUDE_AUTO}
       ORDER BY uid, ts ASC`
    ).all(),
    // User-set nicknames. Emitted as a flat uid→nickname map so the admin
    // frontend can annotate the uid-drill-down popups without a second round
    // trip. EXCLUDE_AUTO keeps the seed fixture out.
    db.prepare(
      `SELECT uid, nickname FROM users
       WHERE nickname IS NOT NULL AND nickname != '' AND ${EXCLUDE_AUTO}`
    ).all(),
    // (date, uid) pairs for the daily-activity bar drill-down. One row per
    // user who answered something that day — JS folds it into a {date: [uid]}
    // map for the popup.
    db.prepare(
      `SELECT date((e.ts + COALESCE(u.tz_offset, 540) * 60000) / 1000, 'unixepoch') AS d, e.uid AS uid
       FROM events e JOIN users u ON u.uid = e.uid
       WHERE ${ANSWER_EVS} AND u.role != 1
       GROUP BY d, e.uid`
    ).all(),
    // uid → timezone offset (minutes east of UTC). Primary source: users.tz_offset
    // (reported on every events POST — covers all users). push_subs.tz_offset is a
    // fallback for users who subscribed but haven't been active since it shipped.
    db.prepare(
      `SELECT uid, tz_offset FROM users
       WHERE tz_offset IS NOT NULL AND ${EXCLUDE_AUTO}`
    ).all(),
    db.prepare(
      `SELECT uid, tz_offset FROM push_subs
       WHERE tz_offset IS NOT NULL AND ${EXCLUDE_AUTO}
       GROUP BY uid`
    ).all(),
  ]);

  // Replay the skill-state machine per user to derive each user's current
  // per-vowel skill. Rules live in src/shared/skill.js, shared with app + dashboard.
  // uid → tz_offset (minutes east of UTC), so each user's distinct-days count is
  // bucketed in their own local day (JST 540 default), like the daily chart above.
  const tzOf = {};
  for (const r of userTzRows.results || []) tzOf[r.uid] = r.tz_offset;

  const perUser = {};
  const userAnswers = {};   // per-user count of answer events (a/g/y/n)
  const userDays = {};      // per-user set of YYYY-MM-DD strings (each user's local day)
  for (const e of skillStream.results || []) {
    const v = e.target.slice(-1);
    const cur = perUser[e.uid] || (perUser[e.uid] = {});
    const c = cur[v] || 0;
    if (isAnswerEv(e.ev)) {
      userAnswers[e.uid] = (userAnswers[e.uid] || 0) + 1;
      const day = new Date(e.ts + (tzOf[e.uid] ?? 540) * 60000).toISOString().slice(0, 10);
      (userDays[e.uid] = userDays[e.uid] || new Set()).add(day);
      cur[v] = answeredRight(e) ? onCorrect(c) : onWrong(c);
    } else if (isPenalizedRelisten(e)) {
      cur[v] = onRelisten(c);   // 'r' at cap >= 3 — drop to the start of the current level (free re-listens don't penalize)
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
