// What counts as a "done" day, and how good. Shared by the display layer
// (render.js paints the day-bar from it), the in-app reminder gating, and the
// server-side push cron (worker/src/push.js), so "done" means one thing
// everywhere. DOM-free on purpose: the worker imports this.
//
// A day-stats object is { correct, total, maxRun } — answers right, answers
// total, and the longest correct streak reached that day.
export const DONE = { ANSWERS: 100, GOOD_ANSWERS: 50, GOOD_ACC: 0.95, STREAK: 30 };

// Done-day quality tier: "" (not done) / " done" / " done90" / " done95". A day
// is done by sheer volume, by enough answers at high accuracy, or by a long
// streak; the 90/95 suffixes then grade its accuracy.
export function dayTier(s) {
  if (!s.total) return "";
  const a = s.correct / s.total;
  const done = s.total >= DONE.ANSWERS || (s.total >= DONE.GOOD_ANSWERS && a >= DONE.GOOD_ACC) || (s.maxRun >= DONE.STREAK);
  if (!done) return "";
  if (a >= .95) return " done95";
  if (a >= .90) return " done90";
  return " done";
}
