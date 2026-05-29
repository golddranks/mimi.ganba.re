// Grind mode: at day-start, consult the running per-sound tally — if a heard
// sound has 20+ attempts and one confuser kana dominates its mistakes, drill
// that sound against that confuser (two-button quiz, no skill cap). Exits after
// 50 grind answers, or when today's accuracy clears 95% (with 20+ answers so a
// single early-correct doesn't trip it). Unrelated to doneToday()'s "volume"
// tier despite the shared word.
//
// Interim trigger: the "right" metric is how often the confuser is picked *when
// offered* (picked/offered), but `offered` wasn't recorded until now — so we
// gate on the confuser's share of mistakes (undiluted by un-offered attempts)
// and accumulate `offered` here + in the events to switch to picked/offered once
// enough new data exists.
import { viewMode, stats, today, acc } from "./app.js";
import { daysAgo } from "../shared/dates.js";

// Master switch for the drill. While false the tally still accumulates (and the
// server records opts/skill), but no user is ever pulled into a focused drill —
// we're collecting data to validate the trigger before release. Flip to true to
// ship grind mode.
const GRIND_ENABLED = false;

const GRIND_MIN_ATTEMPTS = 20;
// Interim trigger ("share of mistakes") until enough `offered` data accumulates
// to switch to the true picked/offered rate: the worst confuser must be at
// least this share of the sound's wrong answers, and picked at least this often.
const GRIND_MIN_CONFUSER_SHARE = 0.5;
const GRIND_MIN_CONFUSER = 4;
const GRIND_EXIT_TOTAL = 50;
const GRIND_EXIT_ACC = 0.95;
const GRIND_EXIT_ACC_MIN_TOTAL = 20;

let grind = null;       // null | { target, confuser, answered }
export const getGrind = () => grind;

// Running per-heard-sound tally that detection reads. Shape per heard sound:
//   { n, correct, conf: {picked: count}, offered: {sibling: count} }
// conf = how often each wrong kana was picked; offered = how often each
// distractor was on screen for this sound — the data the future picked/offered
// confusion metric needs. Kept locally (the server has the full history, but
// this avoids a fetch + works offline). Lifetime counts, not a recency window.
let grindTally = {};
try { grindTally = JSON.parse(localStorage.grind_tally) || {}; } catch { }

function bump(target, picked, opts = []) {
  const t = (grindTally[target] ||= { n: 0, correct: 0, conf: {}, offered: {} });
  t.n++;
  if (picked === target) t.correct++;
  else (t.conf ||= {})[picked] = (t.conf[picked] || 0) + 1;
  t.offered ||= {};   // ||= guards entries migrated/saved before offered existed
  for (const o of opts) if (o !== target) t.offered[o] = (t.offered[o] || 0) + 1;
}

export function tallyAnswer(target, picked, opts) {
  bump(target, picked, opts);
  if (!viewMode) localStorage.grind_tally = JSON.stringify(grindTally);
}

// One-time migration of the retired answer log (localStorage.mora_log) into the
// tally, so users from before this change keep their grind history. The log
// format was `<date> <time> <target>/<idx> [<picked>] <ms>ms` — the picked
// field present only on wrong answers. Runs once (guarded on grind_tally being
// unset), then drops the log. Safe to delete this function once clients have
// updated past the change.
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

function loadGrind() {
  try {
    const g = JSON.parse(localStorage.grind);
    if (!g || g.date !== daysAgo(0)) return null;
    return { target: g.target, confuser: g.confuser, answered: g.answered || 0 };
  } catch { return null; }
}

function saveGrind() {
  if (viewMode) return;
  if (grind) localStorage.grind = JSON.stringify({ ...grind, date: daysAgo(0) });
  else delete localStorage.grind;
}

function detectGrindCandidate() {
  let best = null;
  for (const target of Object.keys(grindTally)) {
    const { n, correct = 0, conf = {} } = grindTally[target];
    if (n < GRIND_MIN_ATTEMPTS) continue;
    const wrong = n - correct;
    // Worst confuser = the wrong kana picked most often for this heard sound.
    let confuser = null, count = 0;
    for (const p of Object.keys(conf)) {
      if (conf[p] > count) { count = conf[p]; confuser = p; }
    }
    // Interim metric: the confuser must dominate this sound's *mistakes* (and be
    // picked a few times outright), not clear a share of all attempts — the
    // latter is diluted because the confuser isn't offered every question.
    if (!confuser || count < GRIND_MIN_CONFUSER) continue;
    const share = count / wrong;
    if (share < GRIND_MIN_CONFUSER_SHARE) continue;
    if (!best || share > best.share || (share === best.share && count > best.count)) {
      best = { target, confuser, share, count };
    }
  }
  return best ? { target: best.target, confuser: best.confuser } : null;
}

function grindShouldExit() {
  if (grind.answered >= GRIND_EXIT_TOTAL) return true;
  const s = today();
  return s.total >= GRIND_EXIT_ACC_MIN_TOTAL && acc(s) >= GRIND_EXIT_ACC;
}

// Restore an in-progress grind (same calendar day); otherwise run detection
// only at day-start (today has no answers yet) so we don't yank the user into
// grind mode mid-session.
export function initGrind() {
  migrateLog();
  if (!GRIND_ENABLED) return;   // drill off; tally keeps accumulating above
  grind = loadGrind();
  if (!grind && !stats[daysAgo(0)]) {
    const cand = detectGrindCandidate();
    if (cand) { grind = { ...cand, answered: 0 }; saveGrind(); }
  }
}

// Count one grind answer; leave grind mode when the exit condition trips.
export function recordGrindAnswer() {
  if (!grind) return;
  grind.answered++;
  if (grindShouldExit()) grind = null;
  saveGrind();
}
