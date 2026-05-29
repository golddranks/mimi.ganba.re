// Display layer: paints the score / streak / message readouts and the 30-day
// bar, plus the done-day + mastery assessments that drive their text and
// colour. Read-only over the session state owned by app.js.
import { stats, run, today, acc, emptyDay, DAYS, BAR_MAX } from "./app.js";
import { daysAgo } from "../shared/dates.js";

// A day counts as "done" (gold bar + "enough for today" message) when any of
// these hold: sheer volume, enough answers at high accuracy, or — once that
// day — a long correct streak.
const DONE = { ANSWERS: 100, GOOD_ANSWERS: 50, GOOD_ACC: 0.95, STREAK: 30 };

function mastered() {
  const days = Object.keys(stats).filter((k) => stats[k].total).sort();
  if (!days.length) return false;
  // Tier 1: first ever day, completed at 100%.
  if (days.length === 1) {
    const s = stats[days[0]];
    return s.correct === s.total && doneToday();
  }
  // Tier 2: last 30 days, >=22 trained, every trained day >=90%, last 5 >=95%.
  // w is most-recent-first since daysAgo(0)=today, daysAgo(1)=yesterday, etc.
  const w = Array.from({ length: DAYS }, (_, i) => stats[daysAgo(i)]).filter((s) => s?.total);
  return w.length >= 22
    && w.every((s) => acc(s) >= .90)
    && w.slice(0, 5).every((s) => acc(s) >= .95);
}

// Returns "ace" (accuracy / streak), "volume" (sheer volume), or null. Keys off
// today's best streak (maxRun), not the live one — so hitting a 30-streak ends
// the day even if you then miss one, matching the "day over in 30" tip.
const doneToday = () => {
  const s = today();
  if (s.total >= DONE.GOOD_ANSWERS && acc(s) >= DONE.GOOD_ACC || s.maxRun >= DONE.STREAK) return "ace";
  if (s.total >= DONE.ANSWERS) return "volume";
  return null;
};

// Consecutive recent days where the session was completed (dayTier non-empty).
// Today is special: if it's not "done" yet, it doesn't break the streak —
// the user still has time to finish. Capped at DAYS because stats only
// retains the last DAYS days locally.
function daysStreak() {
  let n = 0;
  for (let i = 0; i < DAYS; i++) {
    const s = stats[daysAgo(i)];
    if (s && dayTier(s)) n++;
    else if (i > 0) break;
  }
  return n;
}

export function render() {
  const s = today();
  score.textContent = `${s.correct} correct out of ${s.total}`
    + (s.total ? ` (${Math.round(acc(s) * 100)}%)` : "");
  streak.hidden = run < 2;
  streak.textContent = `streak: ${run}`;
  const ds = daysStreak();
  daystreak.hidden = ds < 2;
  daystreak.textContent = `days streak: ${ds}`;

  let cls = "", text = "Let's train some more today!";
  if (mastered()) {
    cls = "mastered";
    text = "You mastered this. Maybe try learning something else?";
  } else {
    const mode = doneToday();
    if (mode === "ace") {
      cls = "done";
      text = "You are doing good! That's enough for today! Come again tomorrow!";
    } else if (mode === "volume") {
      cls = "done";
      text = "Putting the work in! That's enough for today! Come again tomorrow!";
    }
  }
  message.className = cls;
  message.textContent = text;

  renderBar();
}

// Done-day quality tier for the day-bar: "" / done / done90 / done95. A day is
// "done" per the DONE thresholds; the 90/95 suffixes then grade its accuracy.
// Exported for reminders.js (the 22:00 nudge fires only on a not-yet-done day).
export function dayTier(s) {
  if (!s.total) return "";
  const a = s.correct / s.total;
  const done = s.total >= DONE.ANSWERS || (s.total >= DONE.GOOD_ANSWERS && a >= DONE.GOOD_ACC) || (s.maxRun >= DONE.STREAK);
  if (!done) return "";
  if (a >= .95) return " done95";
  if (a >= .90) return " done90";
  return " done";
}

function renderBar() {
  const t = daysAgo(0);
  let html = "";
  for (let i = DAYS - 1; i >= 0; i--) {
    const k = daysAgo(i);
    const s = stats[k] || emptyDay();
    const isT = k === t;
    const cls = "bar-bin" + (isT ? " today" : "") + (isT && !s.total ? " empty" : "");
    const stack = "bar-stack" + dayTier(s);
    // Negative animation-delay desyncs each bar's pulse via inline --delay.
    const inner = s.total
      ? `<div class="${stack}" style="height:${Math.min(100, s.total / BAR_MAX * 100)}%;--delay:${-i * 0.37}s">`
      + `<div class="bar-correct" style="height:${s.correct / s.total * 100}%"></div></div>`
      : "";
    html += `<div class="${cls}" title="${k}  ${s.correct} correct out of ${s.total}">${inner}</div>`;
  }
  topbar.innerHTML = html;
}
