// Web Push subscription primitives, shared by the app's reminder opt-in
// (src/main/reminders.js) and the dashboard's notifications control. Browser-side
// (touches navigator/Notification) but app-agnostic — uid and the stats URL are
// passed in. The worker side of push lives in worker/src/push.js.
import { VAPID_PUBLIC_KEY } from "./vapid.js";

// Push needs a configured VAPID key and browser support for service workers +
// the Push API. Absent any of these (older browser, iOS Safari tab, keys not yet
// set) the feature is inert.
export const pushSupported = () =>
  !!VAPID_PUBLIC_KEY && "serviceWorker" in navigator && "PushManager" in window
  && typeof Notification !== "undefined";

// This device's current push subscription, or null. Best-effort: never throws.
export async function currentSubscription() {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js")
      || await navigator.serviceWorker.getRegistration();
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch { return null; }
}

// Register the service worker, subscribe to push, and register the subscription
// with the worker so the cron can reach this device. Idempotent — reuses an
// existing subscription. Returns the subscription (or null if not granted).
// Caller must have obtained permission via a user gesture first.
export async function subscribe(uid, statsUrl) {
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
    fetch(statsUrl + "/v1/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stale }),
    }).catch(() => { });
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
  }
  await fetch(statsUrl + "/v1/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, subscription: sub.toJSON(), tzOffset: -new Date().getTimezoneOffset() }),
  });
  localStorage.push_key = VAPID_PUBLIC_KEY;   // record the key this sub is bound to
  return sub;
}

// Drop this device's subscription, both in the browser and on the worker. Safe
// when there's nothing subscribed.
export async function unsubscribe(statsUrl) {
  const sub = await currentSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  await sub.unsubscribe().catch(() => { });
  await fetch(statsUrl + "/v1/push/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  }).catch(() => { });
  delete localStorage.push_key;
}

// base64url (the VAPID public key) → Uint8Array, as pushManager.subscribe wants.
function urlB64ToBytes(b64) {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
