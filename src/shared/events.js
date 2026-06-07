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
