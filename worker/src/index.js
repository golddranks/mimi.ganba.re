// Anonymous per-answer stats sink for mimi.ganba.re.
// Endpoints:
//   POST /v1/events  body: { uid, events: [{ts, target, idx, picked, cap}, ...] }
//   POST /v1/user    body: { uid, nickname }

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
    "access-control-allow-methods": "POST, OPTIONS",
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
    "INSERT INTO events (uid, ts, target, idx, picked, cap, ms, ev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const inserts = body.events.map((e) => {
    const ev = ["a", "g", "r", "p"].includes(e.ev) ? e.ev : "a";
    return insertEvent.bind(
      body.uid,
      e.ts | 0,
      String(e.target || ""),
      e.idx | 0,
      String(e.picked || ""),
      e.cap | 0,
      e.ms != null ? (e.ms | 0) : null,
      ev,
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
