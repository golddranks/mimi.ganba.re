// Unit tests for the push reminder logic + VAPID signing (worker/src/push.js).
// Pure — no worker, D1, or DOM; runs anywhere node:test does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayStats, dueNudge, vapidAuth, encryptPayload, sendPush, START_HOUR, DONE_HOUR } from "../src/push.js";

const { subtle } = globalThis.crypto;
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const a = (ts, picked, ev = "a", target = "sa") => ({ ts, target, picked, ev });

test("dayStats: counts a/g/y/n, inverts 'n', penalized re-listen resets the streak (free cap-2 doesn't), scopes to the day", () => {
  const day = "2026-06-05";
  const t0 = Date.UTC(2026, 5, 5, 9, 0, 0);
  const rel = (ts, cap) => ({ ts, target: "sa", picked: "", ev: "r", cap });
  const events = [
    a(t0 + 1, "sa"),                       // ✓ run 1
    a(t0 + 2, "sa"),                       // ✓ run 2
    rel(t0 + 3, 3),                        // re-listen at cap 3 → penalized, run 0
    a(t0 + 4, "sa"),                       // ✓ run 1
    a(t0 + 5, "sa"),                       // ✓ run 2
    rel(t0 + 6, 2),                        // re-listen at cap 2 → FREE, run unchanged (2)
    a(t0 + 7, "sa"),                       // ✓ run 3 (max — proves the cap-2 'r' didn't reset)
    a(t0 + 8, "sa", "n"),                  // 'n' + picked==target → ✗ run 0
    a(t0 + 9, "za", "n"),                  // 'n' + picked!=target → ✓ run 1
    a(Date.UTC(2026, 5, 4, 9, 0, 0), "sa"),// yesterday → excluded
    a(t0 + 10, "sa", "p"),                 // play → ignored
  ];
  // maxRun 3 only if the cap-3 'r' reset (else run would reach 4) AND the cap-2 'r' didn't (else 2).
  assert.deepEqual(dayStats(events, day, 0), { correct: 6, total: 7, maxRun: 3 });
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

test("sendPush: POSTs the encrypted body with VAPID auth, TTL, and aes128gcm encoding", async () => {
  let seen;
  const body = new Uint8Array([1, 2, 3]);
  const status = await sendPush("https://push.example.com/x", "vapid t=jwt, k=key", body, async (url, init) => {
    seen = { url, init };
    return { status: 201 };
  });
  assert.equal(status, 201);
  assert.equal(seen.url, "https://push.example.com/x");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "vapid t=jwt, k=key");
  assert.equal(seen.init.headers.TTL, "86400");
  assert.equal(seen.init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(seen.init.body, body, "the aes128gcm payload");
});

// RFC 8291 §5 worked example: a fixed sender key + salt must reproduce the exact
// published ciphertext, proving the HKDF derivation, AES-128-GCM, and aes128gcm
// framing are interop-correct (not merely self-consistent).
test("encryptPayload: matches the RFC 8291 §5 test vector", async () => {
  const v = {
    plaintext: "When I grow up, I want to be a watermelon",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
    uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
    body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  };
  const point = unb64url(v.asPublic);   // 0x04 ‖ X(32) ‖ Y(32)
  const asKeys = {
    privateKey: await subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", d: v.asPrivate, x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) },
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
    ),
    publicKey: await subtle.importKey("raw", point, { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
  const out = await encryptPayload(v.plaintext, { p256dh: v.uaPublic, auth: v.auth }, {
    asKeys, salt: unb64url(v.salt),
  });
  assert.equal(b64url(out), v.body);
});
