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

test("POST /v1/events preserves Y/N event kinds (not coerced to 'a')", async () => {
  const ts = Date.now();
  const events = [
    { ts, target: "sa", idx: 0, picked: "sa", cap: 2, ms: 800, ev: "y", skill: 16 },
    { ts: ts + 1, target: "si", idx: 0, picked: "ti", cap: 2, ms: 900, ev: "n", skill: 16 },
  ];
  const post = await req("POST", "/v1/events", { uid: UID, events });
  assert.equal(post.status, 200, post.data ? JSON.stringify(post.data) : "");

  const got = (await req("GET", `/v1/user/${UID}/events`)).data?.events || [];
  const y = got.find((e) => e.ts === ts);
  const n = got.find((e) => e.ts === ts + 1);
  assert.equal(y?.ev, "y", "y event kind preserved");
  assert.equal(n?.ev, "n", "n event kind preserved");
});

test("POST /v1/push/subscribe stores a subscription (migration 3 gate), unsubscribe drops it", async () => {
  // Unique fake endpoint so this never collides with a real device; cleaned up
  // below. Under the sentinel uid, which always "trained today", so the cron
  // would never actually push to it even if cleanup were skipped.
  const endpoint = `https://push.example.invalid/${UID}-${Date.now()}`;
  const subscription = { endpoint, keys: { p256dh: "BFakeKeyValue", auth: "fakeAuth" } };

  const ok = await req("POST", "/v1/push/subscribe", { uid: UID, subscription, tzOffset: 540 });
  assert.equal(ok.status, 200, ok.data ? JSON.stringify(ok.data) : "");

  const off = await req("POST", "/v1/push/unsubscribe", { endpoint });
  assert.equal(off.status, 200);
});

test("POST /v1/push/subscribe with a malformed body -> 400 (not 500)", async () => {
  const bad = await req("POST", "/v1/push/subscribe", { uid: UID });   // no subscription/tzOffset
  assert.equal(bad.status, 400);
});
