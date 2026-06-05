// Daily-reminder notifications via Web Push. When a returning user (one who has
// skipped a day at least once) opens the page and today isn't done yet, we offer
// to enable reminders; on opt-in we register the service worker, subscribe to
// push, and hand the subscription to the worker. The worker's hourly cron then
// nudges the device at 19:00 (haven't started) / 22:00 (not done) local — which,
// unlike the old in-tab setTimeout, fires even with the app closed.
import { viewMode, stats, today, uid, STATS_URL } from "./app.js";
import { daysAgo } from "../shared/dates.js";
import { dayTier } from "../shared/daytier.js";
import { VAPID_PUBLIC_KEY } from "../shared/vapid.js";

// Push needs a configured VAPID key and browser support for service workers +
// the Push API. Absent any of these (older browser, iOS Safari tab, keys not yet
// set) the whole feature is inert — the app is unaffected.
const pushSupported = () =>
  !!VAPID_PUBLIC_KEY && "serviceWorker" in navigator && "PushManager" in window
  && typeof Notification !== "undefined";

function hasMissedDay() {
  const days = Object.keys(stats).filter((k) => stats[k].total > 0).sort();
  if (days.length === 0) return false;
  if (days[days.length - 1] < daysAgo(1)) return true;   // last training older than yesterday
  for (let i = 1; i < days.length; i++) {                // any gap between trained days
    const a = new Date(days[i - 1]), b = new Date(days[i]);
    if ((b - a) / 86400000 > 1) return true;
  }
  return false;
}

// True if the most recent trained day was begun late (first answer at/after
// 22:00 local) and never finished — a late, abandoned session, which like a
// skipped day is a cue to offer reminders. `start` is the day's first-answer
// wall-clock recorded by the app; days saved before it existed lack it and
// don't qualify. getHours() is the user's own local hour (no tz guesswork — we
// run in their browser).
function lateStartUnfinished() {
  const days = Object.keys(stats).filter((k) => stats[k].total > 0).sort();
  if (days.length === 0) return false;
  const last = stats[days[days.length - 1]];
  return !!last.start && new Date(last.start).getHours() >= 22 && !dayTier(last);
}

export function scheduleReminders() {
  if (viewMode) return;
  if (!pushSupported()) return;

  // ?remind testing/recovery hook, bypassing the gates below. It force-shows the
  // opt-in prompt — the SAME gesture-driven path as the normal flow — rather than
  // requesting permission on load (which browsers refuse to prompt for without a
  // user gesture). ?remind=test also pushes this device once permission is
  // granted, the end-to-end delivery check. Bare ?remind just (re)subscribes.
  const remind = new URLSearchParams(location.search).get("remind");
  if (remind !== null) {
    delete localStorage.remind_optout;             // reinstall: undo a past "no"
    showRemindPrompt({ test: remind === "test" });
    return;
  }

  const missed = hasMissedDay();
  if (!missed && !lateStartUnfinished()) return;
  if (dayTier(today())) return;
  if (Notification.permission === "granted") { subscribe(); return; }
  if (Notification.permission !== "default") return;   // denied — can't ask again
  if (localStorage.remind_optout) return;              // dismissed the pre-prompt before
  showRemindPrompt({ reason: missed ? "missed" : "unfinished" });
}

// Opt-in copy per trigger: a skipped day vs a late, unfinished session — same
// reminder, only the framing differs.
const REMIND_MSG = {
  missed: "It seems you missed training yesterday. Want a daily reminder so you can keep up your daily streak?",
  unfinished: "It seems you didn't finish the training yesterday. Want a daily reminder so you can keep up your daily streak?",
};

// In-app opt-in shown before the browser's permission dialog (which can't be
// previewed or carry a message of our own). The request happens in the click
// handler — a user gesture — which is both nicer UX and what browsers require to
// actually show the prompt. `test` (the ?remind=test path) sends one push once
// subscribed, to verify delivery.
function showRemindPrompt({ test = false, reason = "missed" } = {}) {
  remindprompt.querySelector("span").textContent = REMIND_MSG[reason] || REMIND_MSG.missed;
  remindprompt.hidden = false;
  remindyes.onclick = async () => {
    remindprompt.hidden = true;
    try {
      if (await Notification.requestPermission() !== "granted") return;
      const sub = await subscribe();
      if (test && sub) await testPush(sub);
    } catch { }
  };
  remindno.onclick = () => {
    remindprompt.hidden = true;
    localStorage.remind_optout = "1";
  };
}

// Register the service worker, subscribe to push, and register the subscription
// with the worker so the cron can reach this device. Idempotent — reuses an
// existing subscription. Returns the subscription (or null if not granted).
async function subscribe() {
  if (Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const appKey = urlB64ToBytes(VAPID_PUBLIC_KEY);

  let sub = await reg.pushManager.getSubscription();
  // A subscription is bound to the VAPID key it was made with. If that key has
  // since rotated, the old sub can't be reused — every push 401s, and the browser
  // refuses to re-subscribe with a different key while it lives — so drop it
  // locally + server-side and make a fresh one. We compare against the key we
  // recorded at subscribe time (localStorage.push_key), not
  // sub.options.applicationServerKey, which some browsers (e.g. Firefox) don't
  // expose. A missing tag — any sub predating this code — counts as a mismatch,
  // so already-stranded devices self-heal on their next visit.
  if (sub && localStorage.push_key !== VAPID_PUBLIC_KEY) {
    const stale = sub.endpoint;
    await sub.unsubscribe();
    fetch(STATS_URL + "/v1/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stale }),
    }).catch(() => { });
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
  }
  await fetch(STATS_URL + "/v1/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, subscription: sub.toJSON(), tzOffset: -new Date().getTimezoneOffset() }),
  });
  localStorage.push_key = VAPID_PUBLIC_KEY;   // record the key this sub is bound to
  return sub;
}

// Ask the worker to push this subscription right now (the ?remind=test check).
async function testPush(sub) {
  await fetch(STATS_URL + "/v1/push/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
}

// base64url (the VAPID public key) → Uint8Array, as pushManager.subscribe wants.
function urlB64ToBytes(b64) {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
