#!/usr/bin/env node
// Dependency-free smoke test for the mimi-stats worker. Exercises the request
// paths a schema/code mismatch breaks — above all the INSERT in /v1/events, the
// 500 that motivated the migration system. Run against any base URL:
//
//   node smoke.mjs http://127.0.0.1:8787                       # local miniflare
//   node smoke.mjs https://mimi-stats.golddranks.workers.dev   # production
//
// Writes a couple of rows under the TestUser sentinel uid (nickname 'TestUser'),
// so production aggregates exclude them (see EXCLUDE_TEST in src/index.js). That
// adds ~2 rows per prod run — harmless (out of all stats), or prune with:
//   wrangler d1 execute mimi-stats --remote \
//     --command="DELETE FROM events WHERE uid='00000000-0000-4000-8000-000000000000'"

const base = (process.argv[2] || "").replace(/\/$/, "");
if (!base) {
  console.error("usage: node smoke.mjs <baseURL>");
  process.exit(2);
}

// All-zeros UUID with valid v4 bits — same sentinel as worker/seed.sql, can't
// collide with a real crypto.randomUUID() client.
const UID = "00000000-0000-4000-8000-000000000000";

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? "pass" : "FAIL") + ": " + msg);
  if (!cond) failures++;
};

// Retry only transient connection failures (thrown fetch) — a freshly deployed
// worker can take a beat to answer. Bad HTTP statuses are NOT retried; they're
// real results the assertions judge.
async function req(method, path, body, tries = 5) {
  const init = {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(base + path, init);
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON / empty body */ }
      return { status: res.status, data };
    } catch (e) {
      if (attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  console.log(`smoke: ${base}`);

  // Tag the sentinel user so its events stay out of aggregates.
  const u = await req("POST", "/v1/user", { uid: UID, nickname: "TestUser" });
  check(u.status === 200, `POST /v1/user -> 200 (got ${u.status})`);

  // The load-bearing check: a non-empty INSERT, carrying the opts/skill columns.
  // This is what 500s when a column the code writes is missing from the table.
  const ts = Date.now();
  const events = [
    { ts, target: "sa", idx: 0, picked: "sa", cap: 4, ms: 1234, ev: "a", opts: ["sa", "za"], skill: 3 },
    { ts: ts + 1, target: "si", idx: 0, picked: "ti", cap: 3, ms: 2345, ev: "g", opts: ["si", "ti"], skill: 1 },
  ];
  const post = await req("POST", "/v1/events", { uid: UID, events });
  check(post.status === 200,
    `POST /v1/events -> 200 (got ${post.status}${post.data ? " " + JSON.stringify(post.data) : ""})`);
  check(post.data && post.data.count === events.length,
    `POST /v1/events accepted ${events.length} events`);

  // Read them back — proves the row persisted and the read path returns cleanly.
  const get = await req("GET", `/v1/user/${UID}/events`);
  check(get.status === 200, `GET /v1/user/:uid/events -> 200 (got ${get.status})`);
  const got = (get.data && get.data.events) || [];
  check(got.some((e) => e.ts === ts && e.target === "sa"),
    "round-trip: just-posted event is present");

  // Negative path still wired (no events[] -> 400, not 500).
  const bad = await req("POST", "/v1/events", { uid: UID });
  check(bad.status === 400, `POST /v1/events (no events[]) -> 400 (got ${bad.status})`);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL GOOD");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("smoke error:", e && e.message); process.exit(1); });
