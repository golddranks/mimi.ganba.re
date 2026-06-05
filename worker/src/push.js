// Web Push for the daily reminder cron (scheduled() in index.js). Pure logic +
// VAPID signing, kept out of index.js so it can be unit-tested without a worker
// or D1 (worker/test/push.test.mjs). Payloadless push: we send an empty body and
// the service worker shows a fixed message, which avoids RFC 8291 payload
// encryption entirely — VAPID identification (a signed JWT) is all that's needed.
import { pad2 } from "../../src/shared/dates.js";
import { dayTier } from "../../src/shared/daytier.js";

export const START_HOUR = 19;   // local hour for the "haven't started today" nudge
export const DONE_HOUR = 22;    // local hour for the "not done yet" nudge

const enc = new TextEncoder();
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s) => b64url(enc.encode(s));

// Local wall-clock parts for a UTC instant, given the device's offset (minutes
// to ADD to UTC). Read via getUTC* on the shifted Date so it's independent of
// the worker process's own timezone. `stamp` (day + hour) is the dedupe key.
export function localStamp(nowMs, tzOffset) {
  const d = new Date(nowMs + tzOffset * 60000);
  const day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const hour = d.getUTCHours();
  return { day, hour, stamp: `${day}T${hour}` };
}

const isAnswer = (ev) => ev === "a" || ev === "g" || ev === "y" || ev === "n";
// 'n' is the Y/N "no" answer — correct when the kana did NOT match (picked != target).
const answeredRight = (e) => (e.ev === "n" ? e.picked !== e.target : e.picked === e.target);

// Reconstruct { correct, total, maxRun } for one local day from a user's events.
// Replays that day's answers in ts order, with relistens ('r') breaking the
// streak — mirroring applyAnswer / applyRelisten in app.js, so "done" here means
// what it means in the app.
export function dayStats(events, day, tzOffset) {
  const todays = events
    .filter((e) => (isAnswer(e.ev) || e.ev === "r") && localStamp(e.ts, tzOffset).day === day)
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

// Send one payloadless push; returns the HTTP status so the caller can prune the
// subscription on 404/410 (gone). fetchImpl is injectable for tests.
export async function sendPush(endpoint, authHeader, fetchImpl = fetch) {
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { Authorization: authHeader, TTL: "86400" },
  });
  return res.status;
}
