// Daily-reminder notifications via Web Push. When a returning user (one who has
// skipped a day at least once) opens the page and today isn't done yet, we offer
// to enable reminders; on opt-in we register the service worker, subscribe to
// push, and hand the subscription to the worker. The worker's hourly cron then
// nudges the device at 19:00 (haven't started) / 22:00 (not done) local — which,
// unlike the old in-tab setTimeout, fires even with the app closed.
import { viewMode, stats, today, uid, STATS_URL } from "./app.js";
import { daysAgo } from "../shared/dates.js";
import { dayTier } from "../shared/daytier.js";
import { pushSupported, subscribe } from "../shared/push.js";

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
  if (Notification.permission === "granted") { subscribe(uid, STATS_URL); return; }
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
      const sub = await subscribe(uid, STATS_URL);
      if (test && sub) await testPush(sub);
    } catch { }
  };
  remindno.onclick = () => {
    remindprompt.hidden = true;
    localStorage.remind_optout = "1";
  };
}

// Ask the worker to push this subscription right now (the ?remind=test check).
async function testPush(sub) {
  await fetch(STATS_URL + "/v1/push/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
}
