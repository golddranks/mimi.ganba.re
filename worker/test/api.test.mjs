// Worker API gate — the migration check. Exercises the request paths a
// schema/code mismatch breaks, above all the INSERT in /v1/events (the 500 the
// migration system exists to catch). Runs against any BASE: a local miniflare
// worker (pre-deploy) or the live worker (post-deploy).
//
// Writes a couple of rows under the TestUser sentinel uid, which production
// aggregates exclude (EXCLUDE_TEST in src/index.js). Prune prod rows with:
//   wrangler d1 execute mimi-stats --remote \
//     --command="DELETE FROM events WHERE uid='00000000-0000-4000-8000-000000000000'"
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");
// All-zeros UUID with valid v4 bits — same sentinel as seed.sql.
const UID = "00000000-0000-4000-8000-000000000000";

// Retry only transient connection failures (a freshly deployed worker can take
// a beat to answer). Bad HTTP statuses are real results, not retried.
async function req(method, path, body, tries = 5) {
  const init = {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(BASE + path, init);
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON / empty body */ }
      return { status: res.status, data };
    } catch (e) {
      if (attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

test("POST /v1/user tags the sentinel user", async () => {
  const u = await req("POST", "/v1/user", { uid: UID, nickname: "TestUser" });
  assert.equal(u.status, 200);
});

test("POST /v1/events inserts (migration gate) and round-trips", async () => {
  const ts = Date.now();
  const events = [
    { ts, target: "sa", idx: 0, picked: "sa", cap: 4, ms: 1234, ev: "a", opts: ["sa", "za"], skill: 3 },
    { ts: ts + 1, target: "si", idx: 0, picked: "ti", cap: 3, ms: 2345, ev: "g", opts: ["si", "ti"], skill: 1 },
  ];
  const post = await req("POST", "/v1/events", { uid: UID, events });
  assert.equal(post.status, 200, post.data ? JSON.stringify(post.data) : "");
  assert.equal(post.data?.count, events.length);

  const get = await req("GET", `/v1/user/${UID}/events`);
  assert.equal(get.status, 200);
  const got = get.data?.events || [];
  assert.ok(got.some((e) => e.ts === ts && e.target === "sa"), "just-posted event present");
});

test("POST /v1/events with no events[] -> 400 (not 500)", async () => {
  const bad = await req("POST", "/v1/events", { uid: UID });
  assert.equal(bad.status, 400);
});
