// Grind mode (day-start drilling). On the first question of a new day it runs in
// two phases, both presented as the existing two-button drill (target vs a
// confuser, no skill cap):
//
//   1. Probe phase — ask up to 5 questions on the current *probe target* (the
//      most uncertain confusion), recomputing it from fresh data after each
//      answer, to sharpen the estimates.
//   2. Grind phase — if any *grind targets* remain (confusions we're >95% sure
//      exceed a 20% wrong-rate), drill the one with the highest wrong-rate until
//      the exit condition trips (50 grind answers, or today's accuracy clears
//      95% with 20+ answers).
//
// Targets come from shared/confusion.js (Beta(1,4) posterior on the
// pick-when-offered rate), computed from the running per-sound tally below —
// which only counts answers that recorded their offered choices (opts), the data
// that metric needs. Kept locally so it works offline without a fetch.
import { viewMode, stats, today, acc } from "./app.js";
import { daysAgo } from "../shared/dates.js";
import { confusionTargets } from "../shared/confusion.js";
import { bump, tallyMaps } from "../shared/tally.js";

// Probing — drilling your most uncertain confusion at day-start — ships
// unflagged. GRIND_ENABLED gates only the *grind* phase that would follow the
// probes (the focused drill of a confirmed grind target), which isn't released
// yet; until it's on, probing just ends and normal questions resume. The tally
// accumulates either way. Flip to true to also ship grind.
const GRIND_ENABLED = false;

const PROBE_MAX = 5;            // questions spent probing at day-start
const GRIND_EXIT_TOTAL = 50;
const GRIND_EXIT_ACC = 0.95;
const GRIND_EXIT_ACC_MIN_TOTAL = 20;

// null | { phase: "probe", probesAsked } | { phase: "grind", target, confuser, answered }
let grind = null;

// Running per-heard-sound tally the targets are computed from (shape and the
// bump/tallyMaps logic live in shared/tally.js, shared with the dashboard so the
// two can't drift). Lifetime counts, not a recency window.
let grindTally = {};
try { grindTally = JSON.parse(localStorage.grind_tally) || {}; } catch { }

export function tallyAnswer(target, picked, opts) {
  bump(grindTally, target, picked, opts);
  if (!viewMode) localStorage.grind_tally = JSON.stringify(grindTally);
}

// One-time migration of the retired answer log (localStorage.mora_log) into the
// tally, so users from before this change keep their volume history. The log
// format was `<date> <time> <target>/<idx> [<picked>] <ms>ms` — the picked field
// present only on wrong answers; it has no opts, so it adds n/correct only. Runs
// once (guarded on grind_tally being unset), then drops the log. Safe to delete
// once clients have updated past the change.
function migrateLog() {
  if (localStorage.grind_tally != null || !localStorage.mora_log) return;
  for (const line of localStorage.mora_log.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const target = parts[2].split("/")[0];
    bump(grindTally, target, parts.length === 5 ? parts[3] : target);
  }
  localStorage.grind_tally = JSON.stringify(grindTally);
  delete localStorage.mora_log;
}

const splitKey = (k) => { const [target, confuser] = k.split("/"); return { target, confuser }; };

function currentProbe() {
  const { shown, offered } = tallyMaps(grindTally);
  const { probe } = confusionTargets(shown, offered);
  return probe ? splitKey(probe) : null;
}

function bestGrindTarget() {
  const { shown, offered } = tallyMaps(grindTally);
  const { bestGrind } = confusionTargets(shown, offered);
  return bestGrind ? splitKey(bestGrind) : null;
}

export const getGrind = () => {
  if (!grind) return null;
  if (grind.phase === "probe") {
    const probe = currentProbe();
    if (probe) return probe;     // recomputed from fresh data each question
    startGrindPhase();           // nothing left to probe → move on early
  }
  if (grind && grind.phase === "grind") return { target: grind.target, confuser: grind.confuser };
  return null;
};

function startGrindPhase() {
  // Probing is over; enter the grind phase only if it's released, else end
  // (grind = null → normal questions).
  const g = GRIND_ENABLED ? bestGrindTarget() : null;
  grind = g ? { phase: "grind", target: g.target, confuser: g.confuser, answered: 0 } : null;
  saveGrind();
}

function loadGrind() {
  try {
    const g = JSON.parse(localStorage.grind);
    if (!g || g.date !== daysAgo(0) || !g.phase) return null;
    if (g.phase === "grind" && !GRIND_ENABLED) return null;   // grind not released
    return g;
  } catch { return null; }
}

function saveGrind() {
  if (viewMode) return;
  if (grind) localStorage.grind = JSON.stringify({ ...grind, date: daysAgo(0) });
  else delete localStorage.grind;
}

function grindShouldExit() {
  if (grind.answered >= GRIND_EXIT_TOTAL) return true;
  const s = today();
  return s.total >= GRIND_EXIT_ACC_MIN_TOTAL && acc(s) >= GRIND_EXIT_ACC;
}

// Restore an in-progress run (same calendar day); otherwise start the probe phase
// only at day-start (today has no answers yet) so we don't yank the user into a
// drill mid-session.
// Secret testing flag: ?morning forces the day-start probe phase to (re)start,
// even mid-session or after answering today — so the probe drilling can be
// exercised on demand without waiting for a real new day.
const FORCE_MORNING = new URLSearchParams(location.search).has("morning");

export function initGrind() {
  migrateLog();
  grind = loadGrind();
  // At day-start (today has no answers yet) begin probing, so we don't yank the
  // user into a drill mid-session. Probing is always on; the grind phase that may
  // follow it is gated in startGrindPhase. ?morning forces it for testing.
  if (FORCE_MORNING || (!grind && !stats[daysAgo(0)])) {
    grind = { phase: "probe", probesAsked: 0 };
    saveGrind();
  }
}

// Advance the state machine after each answer (the answer has already updated the
// tally via tallyAnswer, so the next probe recomputes from fresh data).
export function recordGrindAnswer() {
  if (!grind) return;
  if (grind.phase === "probe") {
    grind.probesAsked++;
    if (grind.probesAsked >= PROBE_MAX) startGrindPhase();
    else saveGrind();
  } else {
    grind.answered++;
    if (grindShouldExit()) grind = null;
    saveGrind();
  }
}
