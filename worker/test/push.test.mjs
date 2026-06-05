// Unit tests for the push reminder logic + VAPID signing (worker/src/push.js).
// Pure — no worker, D1, or DOM; runs anywhere node:test does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayStats, dueNudge, vapidAuth, sendPush, START_HOUR, DONE_HOUR } from "../src/push.js";

const { subtle } = globalThis.crypto;
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const a = (ts, picked, ev = "a", target = "sa") => ({ ts, target, picked, ev });

test("dayStats: counts a/g/y/n, inverts 'n', relisten resets the streak, scopes to the day", () => {
  const day = "2026-06-05";
  const t0 = Date.UTC(2026, 5, 5, 9, 0, 0);
  const events = [
    a(t0 + 1, "sa"),                       // ✓ run 1
    a(t0 + 2, "sa"),                       // ✓ run 2 (max)
    a(t0 + 3, "za"),                       // ✗ run 0
    a(t0 + 4, "sa"),                       // ✓ run 1
    a(t0 + 5, "", "r"),                    // relisten → run 0
    a(t0 + 6, "sa"),                       // ✓ run 1
    a(t0 + 7, "sa", "n"),                  // 'n' + picked==target → ✗ run 0
    a(t0 + 8, "za", "n"),                  // 'n' + picked!=target → ✓ run 1
    a(Date.UTC(2026, 5, 4, 9, 0, 0), "sa"),// yesterday → excluded
    a(t0 + 9, "sa", "p"),                  // play → ignored
  ];
  assert.deepEqual(dayStats(events, day, 0), { correct: 5, total: 7, maxRun: 2 });
});

test("dueNudge: start hour fires only with no answers today", () => {
  const now = Date.UTC(2026, 5, 5, START_HOUR, 0, 0);   // local hour 19 at tz 0
  const sub = { tz_offset: 0, last_push: null };
  assert.deepEqual(dueNudge(sub, [], now), { tier: "start", stamp: "2026-06-05T19" });
  assert.equal(dueNudge(sub, [a(Date.UTC(2026, 5, 5, 8, 0, 0), "sa")], now), null);
});

test("dueNudge: done hour fires only when the day isn't done", () => {
  const now = Date.UTC(2026, 5, 5, DONE_HOUR, 0, 0);
  const sub = { tz_offset: 0, last_push: null };
  assert.deepEqual(dueNudge(sub, [a(Date.UTC(2026, 5, 5, 8, 0, 0), "sa")], now), { tier: "done", stamp: "2026-06-05T22" });
  const many = Array.from({ length: 100 }, (_, i) => a(Date.UTC(2026, 5, 5, 8, 0, 0) + i, "sa"));
  assert.equal(dueNudge(sub, many, now), null, "100 answers → done → no nudge");
});

test("dueNudge: dedupes on last_push and ignores off-hours", () => {
  const start = Date.UTC(2026, 5, 5, START_HOUR, 0, 0);
  assert.equal(dueNudge({ tz_offset: 0, last_push: "2026-06-05T19" }, [], start), null);
  assert.equal(dueNudge({ tz_offset: 0, last_push: null }, [], Date.UTC(2026, 5, 5, 13, 0, 0)), null);
});

test("dueNudge: tz_offset shifts local time (JST +540: 10:00 UTC = 19:00 local)", () => {
  const now = Date.UTC(2026, 5, 5, 10, 0, 0);
  assert.deepEqual(dueNudge({ tz_offset: 540, last_push: null }, [], now), { tier: "start", stamp: "2026-06-05T19" });
});

test("vapidAuth: a verifiable ES256 JWT scoped to the endpoint origin", async () => {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const pub = b64url(await subtle.exportKey("raw", pair.publicKey));

  const header = await vapidAuth("https://push.example.com/abc/def", jwk, pub);
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, "header shape 'vapid t=<jwt>, k=<key>'");
  assert.equal(m[2], pub, "k is our public key");

  const [h, p, sig] = m[1].split(".");
  assert.deepEqual(JSON.parse(unb64url(h).toString()), { typ: "JWT", alg: "ES256" });
  const payload = JSON.parse(unb64url(p).toString());
  assert.equal(payload.aud, "https://push.example.com");
  assert.ok(payload.exp > Math.floor(Date.now() / 1000), "exp in the future");
  assert.match(payload.sub, /^mailto:/);

  const ok = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, pair.publicKey,
    unb64url(sig), new TextEncoder().encode(`${h}.${p}`),
  );
  assert.ok(ok, "signature verifies against the public key");
});

test("sendPush: POSTs payloadless with VAPID auth + TTL, returns the status", async () => {
  let seen;
  const status = await sendPush("https://push.example.com/x", "vapid t=jwt, k=key", async (url, init) => {
    seen = { url, init };
    return { status: 201 };
  });
  assert.equal(status, 201);
  assert.equal(seen.url, "https://push.example.com/x");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "vapid t=jwt, k=key");
  assert.equal(seen.init.headers.TTL, "86400");
  assert.equal(seen.init.body, undefined, "no body — payloadless push");
});
