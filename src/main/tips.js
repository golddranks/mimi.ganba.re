// One-liners shown under the play area. Each tip is tagged with the contexts
// where it's actually useful, and pickTip(ctx) returns a random tip carrying
// that tag — so the hint tracks what the user is doing (see app.js updateTip()),
// maximising the chance it's relevant. Contexts, chosen by page state:
//   beginner — early on, still few buttons: teach the controls and progression
//   review   — just answered wrong: replay mechanics + how to tell sounds apart
//   done     — day complete: keep-the-habit encouragement
//   general  — mid-session default: phonetics, technique, the done thresholds
const TIPS = [
  {
    t: ["beginner", "review"],
    s: "Tip: Pressing long counts as a guess answer, which let's you listen again.",
  },
  {
    t: ["beginner", "review"],
    s: "Tip: Press shortly to listen again the same sound, or long to listen some other voice.",
  },
  {
    t: ["beginner"],
    s: "Tip: Listen again with the button bottom right, but try not to resort to it too often!",
  },
  {
    t: ["beginner"],
    s: "Tip: Once you get good, there will be more buttons to choose from!",
  },
  { t: ["beginner", "general"], s: "Tip: Try achieving long streaks!" },
  {
    t: ["review"],
    s: "Tip: After answering wrong, try pressing the buttons to listen again.",
  },
  {
    t: ["general"],
    s: "Tip: Flawless streak, and your day is over in 30 answers!",
  },
  {
    t: ["general"],
    s: "Tip: Doing well enough, and your day is over in 50 answers!",
  },
  {
    t: ["done"],
    s: "Tip: True masters aren't made in a day. But 30 days of effort will show!",
  },
  {
    t: ["review", "general"],
    s: "Tip: Missing a bunch? Put the work in, and you are still done in 100 answers.",
  },
  {
    t: ["review", "general"],
    s: "Tip: Close your eyes — let your ears do the work.",
  },
  {
    t: ["review", "general"],
    s: "Tip: Voiced sounds (ず, じゅ) make your vocal cords buzz.",
  },
  {
    t: ["review", "general"],
    s: "Tip: つ bursts; す hisses. Listen for the start.",
  },
  {
    t: ["review", "general"],
    s: "Tip: Hear the friction! Hear the bursts! Hear the voicing!",
  },
  {
    t: ["done", "general"],
    s: "Tip: A few minutes, multiple times a day beats one marathon session.",
  },
];

// A random tip tagged for `ctx`, falling back to the whole set if a context has
// none (so it can never come up empty).
export function pickTip(ctx) {
  const pool = TIPS.filter((x) => x.t.includes(ctx));
  const from = pool.length ? pool : TIPS;
  return from[Math.floor(Math.random() * from.length)].s;
}
