// Daily-reminder notifications. When a returning user (one who has skipped a
// day at least once) opens the page and today's session isn't done yet,
// schedule two in-tab nudges:
//   19:00 local — if they still haven't answered a single question today
//   22:00 local — if today still isn't a "done" day (per dayTier rules)
// setTimeout from the page only fires while a tab is open. That's the cost of
// not wiring a service worker; the page-as-reminder still helps anyone who
// keeps a tab around in the background.
import { viewMode, stats, today } from "./app.js";
import { daysAgo } from "../shared/dates.js";
import { dayTier } from "../shared/daytier.js";

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
  if (typeof Notification === "undefined") return;

  // ?remind testing/recovery hook, bypassing every gate below. Bare ?remind
  // re-installs the reminders: clears a past opt-out, asks for permission if
  // needed, and arms the real 19:00/22:00 nudges. ?remind=<seconds> instead
  // fires one test notification after that delay — the mobile delivery check
  // (set it, lock the phone, see whether a backgrounded tab's timer still fires).
  const remind = new URLSearchParams(location.search).get("remind");
  if (remind !== null) { forceReminders(remind); return; }

  if (!hasMissedDay()) return;
  if (dayTier(today())) return;
  if (Notification.permission === "granted") { armReminders(); return; }
  if (Notification.permission !== "default") return;   // denied — can't ask again
  if (localStorage.remind_optout) return;              // dismissed the pre-prompt before
  showRemindPrompt();
}

async function forceReminders(value) {
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { }
  }
  if (Notification.permission !== "granted") return;   // denied/dismissed — can't fire either way
  const secs = Number(value);
  if (value !== "" && Number.isFinite(secs)) {
    setTimeout(() => {
      try { new Notification("mimi.ganba.re", { body: `Test notification (?remind=${value}).`, tag: "mimi-test" }); } catch { }
    }, secs * 1000);
  } else {
    delete localStorage.remind_optout;   // reinstall: undo a past "no"
    armReminders();
  }
}

// In-app opt-in shown before the browser's permission dialog (which can't be
// previewed or carry a message of our own). Only on "Enable" do we call
// requestPermission, so users who'd reflexively block aren't asked and the
// one-shot grant isn't spent; dismissing remembers the choice so we don't nag.
function showRemindPrompt() {
  remindprompt.hidden = false;
  remindyes.onclick = async () => {
    remindprompt.hidden = true;
    try { if (await Notification.requestPermission() === "granted") armReminders(); }
    catch { }
  };
  remindno.onclick = () => {
    remindprompt.hidden = true;
    localStorage.remind_optout = "1";
  };
}

// Wall-clock timers for the two in-tab nudges. Assumes permission is granted.
function armReminders() {
  const at = (hour, condition, body) => {
    const t = new Date(); t.setHours(hour, 0, 0, 0);
    const ms = t - Date.now();
    if (ms <= 0) return;
    setTimeout(() => {
      if (!condition()) return;
      try { new Notification("mimi.ganba.re", { body, tag: `mimi-${hour}` }); } catch { }
    }, ms);
  };
  at(19, () => today().total === 0,
    "Time to train! You haven't started today yet.");
  at(22, () => !dayTier(today()),
    "The day's almost over and you aren't done yet – don't break your streak!");
}
