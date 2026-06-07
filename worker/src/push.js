// Web Push for the daily reminder cron (scheduled() in index.js). Pure logic +
// VAPID signing + RFC 8291 payload encryption, kept out of index.js so it can be
// unit-tested without a worker or D1 (worker/test/push.test.mjs). The reminder
// text rides in an aes128gcm-encrypted body: Android Firefox drops payloadless
// pushes, so a body — not just VAPID identification — is required to reach it.
import { pad2 } from "../../src/shared/dates.js";
import { dayTier } from "../../src/shared/daytier.js";
import { isAnswerEv, answeredRight } from "../../src/shared/events.js";

export const START_HOUR = 19;   // local hour for the "haven't started today" nudge
export const DONE_HOUR = 22;    // local hour for the "not done yet" nudge

// Notification body per nudge tier (dueNudge's `tier`). Becomes event.data.text()
// in the service worker, which shows it verbatim.
export const NUDGE_TEXT = {
  start: "Time to train! Don't break your streak.",
  done: "You're not done for today yet — keep your streak alive.",
};

const enc = new TextEncoder();
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s) => b64url(enc.encode(s));
const b64urlToBytes = (s) =>
  Uint8Array.from(atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

// Local wall-clock parts for a UTC instant, given the device's offset (minutes
// to ADD to UTC). Read via getUTC* on the shifted Date so it's independent of
// the worker process's own timezone. `stamp` (day + hour) is the dedupe key.
export function localStamp(nowMs, tzOffset) {
  const d = new Date(nowMs + tzOffset * 60000);
  const day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const hour = d.getUTCHours();
  return { day, hour, stamp: `${day}T${hour}` };
}

// Reconstruct { correct, total, maxRun } for one local day from a user's events.
// Replays that day's answers in ts order, with relistens ('r') breaking the
// streak — mirroring applyAnswer / applyRelisten in app.js, so "done" here means
// what it means in the app.
export function dayStats(events, day, tzOffset) {
  const todays = events
    .filter((e) => (isAnswerEv(e.ev) || e.ev === "r") && localStamp(e.ts, tzOffset).day === day)
    .sort((a, b) => a.ts - b.ts);
  let correct = 0, total = 0, run = 0, maxRun = 0;
  for (const e of todays) {
    if (e.ev === "r") { run = 0; continue; }
    total++;
    if (answeredRight(e)) { correct++; if (++run > maxRun) maxRun = run; }
    else run = 0;
  }
  return { correct, total, maxRun };
}

// Which nudge a subscription is due for right now, or null. Caller dedupes via
// last_push === stamp (so a given hour-slot fires at most once).
export function dueNudge(sub, events, nowMs) {
  const { day, hour, stamp } = localStamp(nowMs, sub.tz_offset);
  if (sub.last_push === stamp) return null;
  if (hour === START_HOUR) {
    return dayStats(events, day, sub.tz_offset).total === 0 ? { tier: "start", stamp } : null;
  }
  if (hour === DONE_HOUR) {
    return dayTier(dayStats(events, day, sub.tz_offset)) === "" ? { tier: "done", stamp } : null;
  }
  return null;
}

// VAPID Authorization header for a push endpoint (RFC 8292): a short ES256 JWT
// scoped to the endpoint's origin, plus our public key so the service can verify
// it. `privateJwk` is the parsed env.VAPID_PRIVATE_KEY; `publicKey` is base64url.
export async function vapidAuth(endpoint, privateJwk, publicKey, subject = "mailto:reminders@mimi.ganba.re") {
  const aud = new URL(endpoint).origin;
  const head = b64urlStr(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64urlStr(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const signed = `${head}.${body}`;
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signed));
  return `vapid t=${signed}.${b64url(sig)}, k=${publicKey}`;
}

// RFC 8291 aes128gcm payload encryption. We mint an ephemeral ECDH key per
// message, derive the content-encryption key + nonce from the subscription's
// p256dh/auth via HKDF (RFC 8291 §3.4 → RFC 8188), then AES-128-GCM a single
// record. `keys` is { p256dh, auth } (base64url) as stored in push_subs. `opts`
// injects { salt, asKeys } so the RFC 8291 §5 test vector is reproducible.
const CEK_INFO = enc.encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = enc.encode("Content-Encoding: nonce\0");
const KEY_INFO_PREFIX = enc.encode("WebPush: info\0");

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function encryptPayload(message, keys, opts = {}) {
  const uaPublic = b64urlToBytes(keys.p256dh);     // receiver's public point (65 B)
  const authSecret = b64urlToBytes(keys.auth);     // receiver's auth secret (16 B)
  const asKeys = opts.asKeys ||
    await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));

  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));   // sender point (65 B)
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  // Fold auth into the ECDH secret (HKDF-Extract salt=auth, then Expand over
  // "WebPush: info"‖ua‖as), then derive CEK + nonce keyed on the message salt.
  // WebCrypto HKDF is Extract+Expand in one call, matching each step exactly.
  const ikm = await hkdf(authSecret, ecdh, concat(KEY_INFO_PREFIX, uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // One record: plaintext + 0x02 last-record delimiter (RFC 8188), no padding.
  const record = concat(enc.encode(message), Uint8Array.of(0x02));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // RFC 8188 header: salt(16) ‖ rs(4, =4096) ‖ idlen(1, =65) ‖ keyid(=as_public) ‖ ciphertext.
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

// Send one push; returns the HTTP status so the caller can prune the subscription
// on 404/410 (gone). `body` is the aes128gcm payload from encryptPayload.
// fetchImpl is injectable for tests.
export async function sendPush(endpoint, authHeader, body, fetchImpl = fetch) {
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      TTL: "86400",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  return res.status;
}
