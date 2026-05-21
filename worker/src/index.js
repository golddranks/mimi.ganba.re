// Anonymous per-answer stats sink for mimi.ganba.re.
// Endpoints:
//   POST /v1/events                 body: { uid, events: [{ts, target, idx, picked, cap}, ...] }
//   POST /v1/user                   body: { uid, nickname }
//   GET  /v1/user/:uid/events       all events for a single user
//   GET  /v1/admin/stats?uid=…      app-wide aggregates; requires users.power_user = 1

import { nameOf } from "./voicemap.js";

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
      } else if (req.method === "GET" && url.pathname === "/v1/admin/stats") {
        res = await handleAdminStats(req, env, url);
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
    "INSERT INTO events (uid, ts, target, idx, picked, cap, ms, ev, voice) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
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

// App-wide aggregates for power users. Auth is "you-know-the-uid" — the
// requester passes their own uid via ?uid=… and we check users.power_user.
// Random UUIDs are unguessable in practice, and the payload is aggregated
// across all users with no PII, so this matches the rest of the worker's
// soft-auth model.
async function handleAdminStats(req, env, url) {
  const uid = url.searchParams.get("uid") || "";
  const row = await env.mimi_stats.prepare(
    "SELECT power_user FROM users WHERE uid = ?"
  ).bind(uid).first();
  if (!row || row.power_user !== 1) {
    return new Response("forbidden", { status: 403 });
  }

  const db = env.mimi_stats;
  const now = Date.now();
  const d7 = now - 7 * 86400000;
  const d30 = now - 30 * 86400000;

  // Parallel aggregations. Each scans/groups the events table on indexed
  // columns; on the current data size (~thousands of rows) this is sub-second.
  // Add caching here if events grows several orders of magnitude.
  const [totals, active, daily, hourly, byMora, byVoice, confusion, byVoiceConf, byVoicePlayed] = await Promise.all([
    db.prepare(
      `SELECT
         COUNT(*)                                                              AS events,
         COUNT(DISTINCT uid)                                                   AS users,
         SUM(CASE WHEN ev IN ('a','g') THEN 1 ELSE 0 END)                      AS answers,
         SUM(CASE WHEN ev IN ('a','g') AND picked = target THEN 1 ELSE 0 END)  AS correct,
         SUM(CASE WHEN ev = 'r' THEN 1 ELSE 0 END)                             AS relisten
       FROM events`
    ).first(),
    db.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT uid) FROM events WHERE ts > ?) AS d7,
         (SELECT COUNT(DISTINCT uid) FROM events WHERE ts > ?) AS d30`
    ).bind(d7, d30).first(),
    db.prepare(
      `SELECT date(ts/1000, 'unixepoch') AS d,
              COUNT(*) AS n,
              SUM(CASE WHEN picked = target THEN 1 ELSE 0 END) AS correct
       FROM events WHERE ev IN ('a','g')
       GROUP BY d ORDER BY d`
    ).all(),
    db.prepare(
      `SELECT CAST(strftime('%H', ts/1000, 'unixepoch') AS INTEGER) AS h,
              COUNT(*) AS n,
              SUM(CASE WHEN picked = target THEN 1 ELSE 0 END) AS correct
       FROM events WHERE ev IN ('a','g')
       GROUP BY h ORDER BY h`
    ).all(),
    db.prepare(
      `SELECT target AS m,
              COUNT(*) AS n,
              SUM(CASE WHEN picked = target THEN 1 ELSE 0 END) AS correct
       FROM events WHERE ev IN ('a','g')
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
       WHERE voice IS NOT NULL AND ev IN ('a','g','r')
       GROUP BY target, voice`
    ).all(),
    db.prepare(
      `SELECT target AS t, picked AS p, COUNT(*) AS n
       FROM events WHERE ev IN ('a','g')
       GROUP BY target, picked`
    ).all(),
    db.prepare(
      `SELECT target AS t, voice AS v, picked AS p, COUNT(*) AS n
       FROM events
       WHERE ev IN ('a','g') AND voice IS NOT NULL
       GROUP BY target, voice, picked`
    ).all(),
    // by_voice_played — this recording was the one *played* in some 'p'
    // event (regardless of which question prompted it). For 'p' events,
    // voice = picked's voice, so the direct GROUP BY does the right thing.
    db.prepare(
      `SELECT picked AS m, voice AS v, COUNT(*) AS n
       FROM events
       WHERE ev = 'p' AND voice IS NOT NULL
       GROUP BY picked, voice`
    ).all(),
  ]);

  return json({
    totals,
    active,
    daily:     daily.results      || [],
    hourly:    hourly.results     || [],
    by_mora:   byMora.results     || [],
    by_voice:  byVoice.results    || [],
    confusion: confusion.results  || [],
    by_voice_confusion: byVoiceConf.results   || [],
    by_voice_played:    byVoicePlayed.results || [],
  });
}
