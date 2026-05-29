// Per-vowel skill state machine — the single source of truth shared by the
// app (live play + view-as replay), the dashboard (replay), and the worker
// (per-user replay for the admin histograms). `c` is a vowel's running
// correct-count; thresholds unlock more choice buttons.
//
// Imported via esbuild (app/dashboard bundles) and wrangler (worker), so the
// three runtimes can never drift apart.

// Crossing each threshold unlocks one more button: cap = 2..6.
export const LEVELS = [10, 15, 20, 25];

// Highest threshold index reached, or -1 below the first.
export const levelIdx = (c) => {
  let i = -1;
  for (let k = 0; k < LEVELS.length; k++) if (c >= LEVELS[k]) i = k;
  return i;
};

// Number of choice buttons shown at correct-count c (2 at 0, +1 per threshold).
export const capFor = (c) => 3 + levelIdx(c);

// Transitions on the correct-count:
export const onCorrect = (c) => c + 1;                                  // +1
export const onWrong = (c) => { const i = levelIdx(c); return i <= 0 ? 0 : LEVELS[i - 1]; };  // drop to previous level's start
export const onRelisten = (c) => { const i = levelIdx(c); return i < 0 ? 0 : LEVELS[i]; };    // drop to current level's start
