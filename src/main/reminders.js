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

export function scheduleReminders() {
  if (viewMode) return;
  if (!pushSupported()) return;

  // ?remind testing/recovery hook, bypassing the gates below. Bare ?remind
  // re-installs (clears a past opt-out, asks permission if needed, subscribes).
  // ?remind=test additionally asks the worker to push this device right now —
  // the end-to-end delivery check (works even with the app backgrounded).
  const remind = new URLSearchParams(location.search).get("remind");
  if (remind !== null) { forceRemind(remind); return; }

  if (!hasMissedDay()) return;
  if (dayTier(today())) return;
  if (Notification.permission === "granted") { subscribe(); return; }
  if (Notification.permission !== "default") return;   // denied — can't ask again
  if (localStorage.remind_optout) return;              // dismissed the pre-prompt before
  showRemindPrompt();
}

// In-app opt-in shown before the browser's permission dialog (which can't be
// previewed or carry a message of our own). Only on "Enable" do we ask, so users
// who'd reflexively block aren't prompted and the one-shot grant isn't spent;
// dismissing remembers the choice so we don't nag.
function showRemindPrompt() {
  remindprompt.hidden = false;
  remindyes.onclick = async () => {
    remindprompt.hidden = true;
    try { if (await Notification.requestPermission() === "granted") await subscribe(); }
    catch { }
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
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToBytes(VAPID_PUBLIC_KEY),
    });
  }
  await fetch(STATS_URL + "/v1/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, subscription: sub.toJSON(), tzOffset: -new Date().getTimezoneOffset() }),
  });
  return sub;
}

async function forceRemind(value) {
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { }
  }
  if (Notification.permission !== "granted") return;
  delete localStorage.remind_optout;   // reinstall: undo a past "no"
  const sub = await subscribe();
  if (value === "test" && sub) {
    await fetch(STATS_URL + "/v1/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  }
}

// base64url (the VAPID public key) → Uint8Array, as pushManager.subscribe wants.
function urlB64ToBytes(b64) {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
