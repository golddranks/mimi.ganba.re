// Anonymous per-answer stats sink for mimi.ganba.re.
// Endpoints:
//   POST /v1/events                 body: { uid, events: [{ts, target, idx, picked, cap}, ...] }
//   POST /v1/user                   body: { uid, nickname }
//   GET  /v1/user/:uid               { power_user: 0|1|2 } — used by the dashboard to decide whether to show the uid-load form
//   GET  /v1/user/:uid/events       all events for a single user
//   GET  /v1/admin/stats?uid=…      sound/aggregate stats with no device identifiers; requires power_user >= 1
//   GET  /v1/admin/stats/users?uid=…  per-user / uid-drilldown stats; requires power_user >= 2
//
// power_user tiers: 0 = none, 1 = may see the aggregate-only admin sections
// (hour-of-day, per-sound + sound-file difficulty, both confusion matrices),
// 2 = may also see overview, the per-user histograms, daily activity, and the
// uid drill-downs / nicknames. The two admin endpoints map 1:1 onto the tiers.

import { nameOf } from "./voicemap.js";
import { levelIdx, onCorrect, onWrong, onRelisten } from "../../src/shared/skill.js";

// Exclude users tagged as test fixtures so seeded data (worker/seed.sql)
// doesn't pollute global stats. The seed user is INSERTed with this nickname;
// add more nicknames here if other synthetic users get tagged. SQL-injection
// note: this fragment is hard-coded, never user-input.
const EXCLUDE_TEST = "uid NOT IN (SELECT uid FROM users WHERE nickname = 'TestUser')";

// users.power_user for a uid, 0 if unknown. The admin endpoints gate on this.
async function powerLevel(env, uid) {
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
      if (req.method === "POST" && url.pathname === "/v1/events") {
        res = await handleEvents(req, env);
      } else if (req.method === "POST" && url.pathname === "/v1/user") {
        res = await handleUser(req, env);
      } else if (req.method === "GET" && url.pathname.match(/^\/v1\/user\/[^/]+\/events$/)) {
        res = await handleGetEvents(req, env, url);
      } else if (req.method === "GET" && url.pathname.match(/^\/v1\/user\/[^/]+$/)) {
        res = await handleGetUser(req, env, url);
      } else if (req.method === "GET" && url.pathname === "/v1/admin/stats") {
        res = await handleAdminStats(req, env, url);
      } else if (req.method === "GET" && url.pathname === "/v1/admin/stats/users") {
        res = await handleAdminUserStats(req, env, url);
      } else {
        res = new Response("not found", { status: 404 });
      }
    } catch (e) {
      res = new Response("server error: " + (e && e.message), { status: 500 });
    }

    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

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
    const ev = ["a", "g", "r", "p"].includes(e.ev) ? e.ev : "a";
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
  const userTouch = env.mimi_stats.prepare(
    "INSERT INTO users (uid, first_seen, last_seen) VALUES (?, ?, ?) " +
    "ON CONFLICT(uid) DO UPDATE SET last_seen = excluded.last_seen"
  ).bind(body.uid, now, now);

  await env.mimi_stats.batch([...inserts, userTouch]);
  return json({ ok: true, count: body.events.length });
}

async function handleGetEvents(req, env, url) {
  const uid = decodeURIComponent(url.pathname.split("/")[3]);
  const rows = await env.mimi_stats.prepare(
    "SELECT ts, target, idx, picked, cap, ms, ev, voice FROM events WHERE uid = ? ORDER BY ts ASC"
  ).bind(uid).all();
  return json({ events: rows.results || [] });
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

async function handleUser(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.uid !== "string" || typeof body.nickname !== "string") {
    return new Response("bad request", { status: 400 });
  }
  const nickname = body.nickname.trim().slice(0, 64);
  const now = Date.now();
  await env.mimi_stats.prepare(
    "INSERT INTO users (uid, nickname, first_seen, last_seen) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(uid) DO UPDATE SET nickname = excluded.nickname, last_seen = excluded.last_seen"
  ).bind(body.uid, nickname, now, now).run();
  return json({ ok: true });
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

  // Parallel aggregations. Each scans/groups the events table on indexed
  // columns; on the current data size (~thousands of rows) this is sub-second.
  // Add caching here if events grows several orders of magnitude.
  const [hourly, byMora, byVoice, confusion, byVoiceConf, byVoicePlayed] = await Promise.all([
    db.prepare(
      `SELECT CAST(strftime('%H', ts/1000, 'unixepoch') AS INTEGER) AS h,
              COUNT(*) AS n,
              SUM(CASE WHEN picked = target THEN 1 ELSE 0 END) AS correct
       FROM events WHERE ev IN ('a','g') AND ${EXCLUDE_TEST}
       GROUP BY h ORDER BY h`
    ).all(),
    db.prepare(
      `SELECT target AS m,
              COUNT(*) AS n,
              SUM(CASE WHEN picked = target THEN 1 ELSE 0 END) AS correct
       FROM events WHERE ev IN ('a','g') AND ${EXCLUDE_TEST}
       GROUP BY target`
    ).all(),
    // by_voice — per recording when it was the *question* (i.e. target).
    // 'a'/'g'/'r' all have voice = target's voice, so they aggregate
    // naturally; 'p' events are excluded because there voice = picked's
    // voice and they belong to the after-played stream below.
    db.prepare(
      `SELECT target AS m, voice AS v,
              SUM(CASE WHEN ev IN ('a','g') THEN 1 ELSE 0 END)                            AS n,
              SUM(CASE WHEN ev IN ('a','g') AND picked = target THEN 1 ELSE 0 END)        AS correct,
              SUM(CASE WHEN ev = 'r' THEN 1 ELSE 0 END)                                   AS relisten
       FROM events
       WHERE voice IS NOT NULL AND ev IN ('a','g','r') AND ${EXCLUDE_TEST}
       GROUP BY target, voice`
    ).all(),
    db.prepare(
      `SELECT target AS t, picked AS p, COUNT(*) AS n
       FROM events WHERE ev IN ('a','g') AND ${EXCLUDE_TEST}
       GROUP BY target, picked`
    ).all(),
    db.prepare(
      `SELECT target AS t, voice AS v, picked AS p, COUNT(*) AS n
       FROM events
       WHERE ev IN ('a','g') AND voice IS NOT NULL AND ${EXCLUDE_TEST}
       GROUP BY target, voice, picked`
    ).all(),
    // by_voice_played — this recording was the one *played* in some 'p'
    // event (regardless of which question prompted it). For 'p' events,
    // voice = picked's voice, so the direct GROUP BY does the right thing.
    db.prepare(
      `SELECT picked AS m, voice AS v, COUNT(*) AS n
       FROM events
       WHERE ev = 'p' AND voice IS NOT NULL AND ${EXCLUDE_TEST}
       GROUP BY picked, voice`
    ).all(),
  ]);

  return json({
    hourly:    hourly.results     || [],
    by_mora:   byMora.results     || [],
    by_voice:  byVoice.results    || [],
    confusion: confusion.results  || [],
    by_voice_confusion: byVoiceConf.results   || [],
    by_voice_played:    byVoicePlayed.results || [],
  });
}

// Per-user / uid-drilldown stats — the level-2 admin tier. Same soft-auth as
// above but gated at power_user >= 2, because everything here carries device
// identifiers (per-bucket uid lists, the daily-activity uid map, nicknames)
// or app-wide business numbers (overview totals). A level-1 power user gets
// 403 here even though they can read /v1/admin/stats — that's the access split.
async function handleAdminUserStats(req, env, url) {
  const uid = url.searchParams.get("uid") || "";
  if (await powerLevel(env, uid) < 2) {
    return new Response("forbidden", { status: 403 });
  }

  const db = env.mimi_stats;
  const now = Date.now();
  const d7 = now - 7 * 86400000;
  const d30 = now - 30 * 86400000;

  const [totals, active, daily, skillStream, nicks, dailyUidRows] = await Promise.all([
    db.prepare(
      `SELECT
         COUNT(*)                                                              AS events,
         COUNT(DISTINCT uid)                                                   AS users,
         SUM(CASE WHEN ev IN ('a','g') THEN 1 ELSE 0 END)                      AS answers,
         SUM(CASE WHEN ev IN ('a','g') AND picked = target THEN 1 ELSE 0 END)  AS correct,
         SUM(CASE WHEN ev = 'r' THEN 1 ELSE 0 END)                             AS relisten
       FROM events
       WHERE ${EXCLUDE_TEST}`
    ).first(),
    db.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT uid) FROM events WHERE ts > ? AND ${EXCLUDE_TEST}) AS d7,
         (SELECT COUNT(DISTINCT uid) FROM events WHERE ts > ? AND ${EXCLUDE_TEST}) AS d30`
    ).bind(d7, d30).first(),
    db.prepare(
      `SELECT date(ts/1000, 'unixepoch') AS d,
              COUNT(*) AS n,
              SUM(CASE WHEN picked = target THEN 1 ELSE 0 END) AS correct
       FROM events WHERE ev IN ('a','g') AND ${EXCLUDE_TEST}
       GROUP BY d ORDER BY d`
    ).all(),
    // Raw event stream for per-user skill replay. Cheaper than expressing
    // the streak/decay rules in pure SQL. ORDER BY uid keeps each user's
    // sequence contiguous so the JS loop below can compute incrementally.
    db.prepare(
      `SELECT uid, ts, target, picked, ev FROM events
       WHERE ev IN ('a','g','r') AND ${EXCLUDE_TEST}
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
       FROM events WHERE ev IN ('a','g') AND ${EXCLUDE_TEST}
       GROUP BY d, uid`
    ).all(),
  ]);

  // Replay the skill-state machine per user to derive each user's current
  // per-vowel skill. Rules live in src/shared/skill.js, shared with app + dashboard.
  const perUser = {};
  const userAnswers = {};   // per-user count of 'a'/'g' events
  const userDays = {};      // per-user set of YYYY-MM-DD strings (UTC) seen
  for (const e of skillStream.results || []) {
    const v = e.target.slice(-1);
    const cur = perUser[e.uid] || (perUser[e.uid] = {});
    const c = cur[v] || 0;
    if (e.ev === "a" || e.ev === "g") {
      userAnswers[e.uid] = (userAnswers[e.uid] || 0) + 1;
      const day = new Date(e.ts).toISOString().slice(0, 10);
      (userDays[e.uid] = userDays[e.uid] || new Set()).add(day);
      cur[v] = e.picked === e.target ? onCorrect(c) : onWrong(c);
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
    totals,
    active,
    daily: daily.results || [],
    level_hist,
    level_hist_uids,
    activity_hist,
    activity_hist_uids,
    days_hist,
    days_hist_uids,
    nicknames: Object.fromEntries((nicks.results || []).map((r) => [r.uid, r.nickname])),
    daily_uids: (dailyUidRows.results || []).reduce((m, r) => {
      (m[r.d] = m[r.d] || []).push(r.uid);
      return m;
    }, {}),
  });
}
