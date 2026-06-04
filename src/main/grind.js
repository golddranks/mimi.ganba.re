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

// Master switch for the drill. While false the tally still accumulates (and the
// server records opts/skill), but no user is ever pulled into a drill — we're
// collecting data to validate the trigger before release. Flip to true to ship.
const GRIND_ENABLED = false;

const PROBE_MAX = 5;            // questions spent probing at day-start
const GRIND_EXIT_TOTAL = 50;
const GRIND_EXIT_ACC = 0.95;
const GRIND_EXIT_ACC_MIN_TOTAL = 20;

// null | { phase: "probe", probesAsked } | { phase: "grind", target, confuser, answered }
let grind = null;

// Running per-heard-sound tally the targets are computed from. Shape per sound:
//   { n, correct, conf: {picked: count}, offered: {sibling: count} }
// conf = wrong picks (only counted when the choice set was known); offered = how
// often each distractor was on screen. conf[C] <= offered[C], so they form the
// k/n a confusion case needs. Lifetime counts, not a recency window.
let grindTally = {};
try { grindTally = JSON.parse(localStorage.grind_tally) || {}; } catch { }

function bump(target, picked, opts = []) {
  const t = (grindTally[target] ||= { n: 0, correct: 0, conf: {}, offered: {} });
  t.n++;
  t.conf ||= {}; t.offered ||= {};   // guard entries saved before these existed
  if (picked === target) t.correct++;
  // A wrong pick is only a usable confusion when we know what was offered — the
  // picked/offered rate needs numerator and denominator from the same answers.
  else if (opts.length) t.conf[picked] = (t.conf[picked] || 0) + 1;
  for (const o of opts) if (o !== target) t.offered[o] = (t.offered[o] || 0) + 1;
}

export function tallyAnswer(target, picked, opts) {
  bump(target, picked, opts);
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
    bump(target, parts.length === 5 ? parts[3] : target);
  }
  localStorage.grind_tally = JSON.stringify(grindTally);
  delete localStorage.mora_log;
}

// Build the shown[T/P] (wrong picks) and offered[T/P] (offers) maps the target
// classifier expects from the per-sound tally.
function tallyMaps() {
  const shown = {}, offered = {};
  for (const target of Object.keys(grindTally)) {
    const { conf = {}, offered: off = {} } = grindTally[target];
    for (const c of Object.keys(conf)) shown[`${target}/${c}`] = conf[c];
    for (const o of Object.keys(off)) offered[`${target}/${o}`] = off[o];
  }
  return { shown, offered };
}

const splitKey = (k) => { const [target, confuser] = k.split("/"); return { target, confuser }; };

function currentProbe() {
  const { shown, offered } = tallyMaps();
  const { probe } = confusionTargets(shown, offered);
  return probe ? splitKey(probe) : null;
}

function bestGrindTarget() {
  const { shown, offered } = tallyMaps();
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
  const g = bestGrindTarget();
  grind = g ? { phase: "grind", target: g.target, confuser: g.confuser, answered: 0 } : null;
  saveGrind();
}

function loadGrind() {
  try {
    const g = JSON.parse(localStorage.grind);
    if (!g || g.date !== daysAgo(0) || !g.phase) return null;
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
export function initGrind() {
  migrateLog();
  if (!GRIND_ENABLED) return;   // drill off; tally keeps accumulating above
  grind = loadGrind();
  if (!grind && !stats[daysAgo(0)]) {
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
