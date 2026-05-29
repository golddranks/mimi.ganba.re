// Daily-reminder notifications. When a returning user (one who has skipped a
// day at least once) opens the page and today's session isn't done yet,
// schedule two in-tab nudges:
//   19:00 local — if they still haven't answered a single question today
//   22:00 local — if today still isn't a "done" day (per dayTier rules)
// setTimeout from the page only fires while a tab is open. That's the cost of
// not wiring a service worker; the page-as-reminder still helps anyone who
// keeps a tab around in the background.
import { viewMode, stats, today } from "./app.js";
import { daysAgo } from "./dates.js";
import { dayTier } from "./render.js";

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
  if (!hasMissedDay()) return;
  if (dayTier(today())) return;
  if (Notification.permission === "granted") { armReminders(); return; }
  if (Notification.permission !== "default") return;   // denied — can't ask again
  if (localStorage.remind_optout) return;              // dismissed the pre-prompt before
  showRemindPrompt();
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
