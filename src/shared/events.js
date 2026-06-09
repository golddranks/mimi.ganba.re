// What counts as an "answer" event, and whether it was answered correctly —
// shared by the dashboard, the admin replay, and the push reminder so the three
// agree on "activity". Multi-choice (a/g) and Y/N (y/n) are all answers; relisten
// (r), after-play (p), and anything else are not. Correctness: a/g and the Y/N
// "yes" (y) are right when the picked kana is the target; the Y/N "no" (n) is
// right when it ISN'T — the user correctly rejected the shown kana.
//
// The worker's admin SQL mirrors this in CASE expressions (it can't call JS);
// keep the two in step.
export const isAnswerEv = (ev) => ev === "a" || ev === "g" || ev === "y" || ev === "n";
export const answeredRight = (e) => e.ev === "n" ? e.picked !== e.target : e.picked === e.target;

// A re-listen ('r') is recorded for every question, but it only carries the
// skill-reset + streak-break penalty at cap >= 3. At the 2-choice level it's a
// FREE re-listen (relistenCurrent emits it but applies no penalty), so it still
// shows in the re-listen confusion metric without dragging skill/streak down.
// Every place that *replays* the event stream to reconstruct skill or streaks
// (app view-as, the dashboard, the worker's per-user skill) gates the penalty on
// this so a free re-listen never re-applies a phantom penalty.
export const isPenalizedRelisten = (e) => e.ev === "r" && e.cap >= 3;
