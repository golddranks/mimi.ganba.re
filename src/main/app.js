import { capFor, onCorrect, onWrong, onRelisten } from "../shared/skill.js";
import { dateKey, daysAgo } from "../shared/dates.js";
import { HIRAGANA } from "../shared/kana.js";
import { dayTier } from "../shared/daytier.js";
import { pickTip } from "./tips.js";
import { confusionRecord } from "../shared/tally.js";
import { getGrind, tallyAnswer, initGrind, recordGrindAnswer } from "./grind.js";
import { scheduleReminders } from "./reminders.js";
import { updateAvailable } from "../shared/version.js";
import { render } from "./render.js";

// Mora identifiers are kunrei-shiki (ASCII) so audio URLs stay plain ASCII; the
// vowel is just the last letter (sa→a, sya→a, ti→i). HIRAGANA (shared) maps each
// id to its hiragana for the buttons; ALL is its key list. The build injects
// window.VOICE_COUNTS = {mora: n}; audio lives at audio/<vowel>/<mora>/<i>.opus.
const ALL = Object.keys(HIRAGANA);
const COUNTS = window.VOICE_COUNTS;

export const DAYS = 30;
export const BAR_MAX = 50;     // a day with 50+ answers fills the bar to the top
export const emptyDay = () => ({ correct: 0, total: 0, maxRun: 0, start: 0 });

// Elements with id attributes are auto-exposed on window (primary, choices,
// message, score, streak, audio, topbar).
export let stats = {};         // {YYYY-MM-DD: {correct,total}}
export let run = 0;            // running streak of correct answers
let skill = {};                // {vowel: count} — persistent per-vowel level counter
let current = null;            // {target, voice}
let locked = false;            // true while reviewing a wrong answer
let relistenArmed = false;     // re-listen confirm balloon shown, awaiting a 2nd tap

// ---------- persistence ----------
function load() {
  try {
    const t = JSON.parse(localStorage.mora) || {};
    // A streak only counts as long as the user keeps training — a missed
    // day breaks it. If the most recent day in stats isn't today, drop the
    // saved streak before it gets restored into `run`.
    if (t.s && t.k) {
      const lastDay = Object.keys(t.s).sort().pop();
      if (lastDay && lastDay !== daysAgo(0)) t.k = 0;
    }
    return t;
  } catch { return {}; }
}
const save = () => {
  if (viewMode) return;
  localStorage.mora = JSON.stringify({ s: stats, k: run, x: skill });
};


// ---------- server-side stats ----------
// When served from localhost (via scripts/dev.sh), talk to the local wrangler
// dev worker instead of production. Set "" to disable uploads entirely.
export const STATS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? `http://${location.hostname}:8787`
  : "https://mimi-stats.golddranks.workers.dev";

// The uid + per-answer events carry no information linking back to a real
// person — anonymous behavioral data, not personal data under GDPR Art. 4(1).
// We send these freely from day 1, no consent prompt.
// ?uid=foo in the URL enables "view-as" mode: the page renders that user's
// state pulled from the server, and nothing is persisted to localStorage or
// sent back. Refresh without the param to return to your own state.
const spoofedUid = new URLSearchParams(location.search).get("uid");
export const viewMode = !!spoofedUid;
export const uid = spoofedUid || (localStorage.uid ||= crypto.randomUUID());
// Native-tester mode (role 2): forced-pair confusion drilling, no grind/probe,
// 2-choice only. Persisted once opted in via ?nativeTester (set below).
export let nativeMode = !viewMode && localStorage.nativeMode === "1";
let evQueue = [];
try { evQueue = JSON.parse(localStorage.ev_queue || "[]"); } catch { }

function pushEvent(ev) {
  if (!STATS_URL || viewMode) return;
  evQueue.push(ev);
  localStorage.ev_queue = JSON.stringify(evQueue);
  flushEvents();
}

// The user's reminder opt-in engagement, reported so the admin/dashboard can see
// it (the subscription itself lives server-side in push_subs): "declined" (said no
// or blocked the browser prompt) > "offered" (prompt shown, no answer) > null
// (never shown). Synchronous read of local + browser state.
const remindState = () =>
  (localStorage.remind_optout || (typeof Notification !== "undefined" && Notification.permission === "denied")) ? "declined"
    : localStorage.remind_shown ? "offered"
      : null;

let flushing = false;
async function flushEvents() {
  if (!STATS_URL || flushing || evQueue.length === 0) return;
  flushing = true;
  const batch = evQueue.slice(0, 100);
  try {
    const res = await fetch(STATS_URL + "/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid, events: batch, tz: -new Date().getTimezoneOffset(), remind_state: remindState() }),
    });
    if (res.ok) {
      evQueue.splice(0, batch.length);
      localStorage.ev_queue = JSON.stringify(evQueue);
    }
  } catch { /* offline; retry next event or session */ }
  finally {
    flushing = false;
    if (evQueue.length > 0) setTimeout(flushEvents, 5000);
  }
}

// ---------- stats ----------
export const today = () => stats[daysAgo(0)] || emptyDay();
export const acc = (s) => s.total ? s.correct / s.total : 0;

// Fold one event into the global (stats[day], skill[vowel], run) state. Shared
// by live play (record / relistenCurrent) and by the view-as replay
// (loadAsUser); the day-boundary streak reset is the caller's concern.
function applyAnswer(day, vowel, correct) {
  const s = (stats[day] ||= emptyDay());
  s.total++;
  if (correct) {
    s.correct++;
    skill[vowel] = onCorrect(skill[vowel] || 0);
    run++;
    if (run > (s.maxRun || 0)) s.maxRun = run;
  } else {
    skill[vowel] = onWrong(skill[vowel] || 0);
    run = 0;
  }
}
function applyRelisten(vowel) {
  skill[vowel] = onRelisten(skill[vowel] || 0);
  run = 0;
}

// ---------- contextual tips ----------
// The hint under the play area tracks page state so it tends to be relevant (see
// tips.js). The context is derived from where the user is: a finished day, the
// early game (before Y/N unlocks at skill 15), or mid-session. "review" isn't
// derived here — wrong-answer handlers pass it explicitly via updateTip("review").
function tipContext() {
  if (dayTier(today())) return "done";
  if (Math.max(0, ...Object.values(skill)) < 15) return "beginner";
  return "general";
}

// Re-roll the tip when the context changes (or when a handler forces one), but
// leave it alone while the context holds — so it reflects the phase rather than
// flickering on every answer.
let tipContextShown = null;
function updateTip(force) {
  if (viewMode) return;   // view-as shows the spoofed-uid label instead
  if (nativeMode) { tip.textContent = "ネイティブ検証モード：発音が変だったり、自信がなかったりするときは、長押しで回答してください"; return; }   // native manages its own status line
  const ctx = force || tipContext();
  if (!force && ctx === tipContextShown) return;
  tipContextShown = ctx;
  tip.textContent = pickTip(ctx);
}

function record(correct, vowel) {
  // Midnight rollover: if today's bucket doesn't exist yet but other days
  // do, the streak from the most recent day is stale — same reset rule as
  // load() applies, just from a long-open session crossing midnight.
  const todayKey = daysAgo(0);
  if (!stats[todayKey] && Object.keys(stats).length > 0) run = 0;
  applyAnswer(todayKey, vowel, correct);
  stats[todayKey].start ||= Date.now();   // wall-clock of the day's first answer (late-start reminder cue)
  const cutoff = daysAgo(DAYS - 1);
  for (const x of Object.keys(stats)) if (x < cutoff) delete stats[x];
  recordGrindAnswer();
  save();
  render();
  updateTip();
}

// ---------- audio / question flow ----------
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

const rand = (m) => Math.floor(Math.random() * COUNTS[m]);
function path(m, i) {
  return `audio/${m.slice(-1)}/${m}/${i}.opus`;
}

// Per-recording answer counts from the server ({mora:{idx:n}}), fetched once,
// best-effort, to bias toward the least-judged recordings so the dataset evens
// out. `voicePlayed` counts this session's own picks per recording.
let voiceAttempts = {};
const voicePlayed = {};
if (STATS_URL) {
  fetch(STATS_URL + "/v1/voice-attempts")
    .then((r) => r.ok ? r.json() : null)
    .then((d) => { if (d) voiceAttempts = d; })
    .catch(() => { });
}

// Choose a recording index for mora `m`. Ordered lexicographically:
//   1. fewest plays THIS session — so we cycle through every recording of the
//      sound once before repeating any (variety within a session); without this
//      a freshly-deployed count-0 recording would be replayed on a loop in a
//      grind session until it caught up to the others' global counts.
//   2. fewest answers globally (the server count) — within a round, the
//      under-sampled recordings come first, nudging the dataset even.
// Random among exact ties. Records the pick so the next call advances the round.
// Question voice only; distractor/replay samples stay uniform (rand) as they
// generate no judgement data.
function pickVoice(m) {
  const base = voiceAttempts[m] || {};
  const local = voicePlayed[m] || (voicePlayed[m] = {});
  let best = [], bestL = Infinity, bestB = Infinity;
  for (let i = 0; i < COUNTS[m]; i++) {
    const l = local[i] || 0, b = base[i] || 0;
    if (l < bestL || (l === bestL && b < bestB)) { bestL = l; bestB = b; best = [i]; }
    else if (l === bestL && b === bestB) best.push(i);
  }
  const i = best[Math.floor(Math.random() * best.length)];
  local[i] = (local[i] || 0) + 1;
  return i;
}
function play(src) {
  audio.src = src;
  audio.currentTime = 0;
  audio.play().catch(() => { });
}

// Fraction of *normal* questions (not grind/probe drills) that become a Y/N
// quiz, once the target's vowel group has unlocked it (cap >= 4 buttons).
const YN_RATIO = 0.2;

// Clear per-question UI before the next question renders.
function resetQuiz() {
  choices.hidden = true;
  yn.hidden = true;
  ynactual.hidden = true;
  for (const b of [ynyes, ynno]) b.classList.remove("correct", "wrong");
}

function newQuestion() {
  locked = false;
  disarmRelisten();
  resetQuiz();
  updateTip();   // back to the phase-appropriate tip after any "review" override
  if (nativeMode) { nativeQuestion(); return; }
  let target, opts;
  const g = getGrind();
  if (g) {
    // Two-button drill on the detected confuser pair. In practice the pair is
    // always same-vowel because the normal-mode generator only ever offers
    // same-vowel buttons, so a confuser can't have a different vowel than its
    // target.
    target = Math.random() < 0.5 ? g.target : g.confuser;
    opts = shuffle([g.target, g.confuser]);
  } else {
    // Stay strictly within the target's vowel group (last char of kunrei).
    // The cap is a maximum; small groups (e.g. i has only si/zi/ti) give fewer.
    // Level is tracked per vowel group: each group ramps up independently.
    target = pick(ALL);
    const v = target.slice(-1);
    const cap = capFor(skill[v] || 0);
    // Y/N quiz unlocks at cap >= 4 buttons (skill >= 15) for this vowel group;
    // a fraction of those normal questions use it instead of multi-choice.
    if (cap >= 4 && Math.random() < YN_RATIO) { newYNQuestion(target, v); return; }
    const sibs = ALL.filter((m) => m !== target && m.endsWith(v));
    opts = shuffle([target, ...shuffle(sibs).slice(0, cap - 1)]);
  }
  askChoices(target, pickVoice(target), opts);
}

// Lay out a multi-choice question for `target` played at recording `idx`, with
// `opts` (the target plus distractors, pre-shuffled) as the buttons. Shared by
// the normal generator and native mode — only how (target, idx, opts) are chosen
// differs. skill is frozen into the event so changing the level rules can't
// rewrite history.
function askChoices(target, idx, opts) {
  current = { target, idx, voice: path(target, idx), cap: opts.length, startTs: Date.now(), opts, skill: skill[target.slice(-1)] || 0, kind: "m" };
  primary.hidden = true;
  relisten.hidden = false;   // a sound to replay exists now
  // Each button gets a fixed sample index — tapping a button during review
  // always replays the same audio. Long-press during review plays a random one.
  choices.innerHTML = opts
    .map((m) => {
      const i = m === target ? idx : rand(m);
      return `<button class="choice" data-mora="${m}" data-idx="${i}">${HIRAGANA[m]}</button>`;
    })
    .join("");
  choices.hidden = false;
  play(current.voice);
}

// ---------- native-tester mode ----------
// A native session is a pre-ranked batch of (recording, confuser) pairs from the
// worker — worst pairwise wrong-rate first (see /v1/native/pairs). We drill them
// in order as forced 2-choice questions, no grind/probe/Y-N, no repeats within a
// batch. When the batch is spent we fetch a freshly-ranked one, which by then
// includes this session's own answers (natives validating natives).
let nativePairs = [], nativePtr = 0;
async function loadNativePairs() {
  try {
    const r = await fetch(STATS_URL + "/v1/native/pairs");
    nativePairs = (r.ok && (await r.json()).pairs) || [];
  } catch { nativePairs = []; }
  nativePtr = 0;
}
// Next still-valid pair, or null when the batch is exhausted. Skips any pair the
// running build can no longer present (recording index dropped, kana unknown).
function nextNativePair() {
  while (nativePtr < nativePairs.length) {
    const p = nativePairs[nativePtr++];
    if (p.idx < (COUNTS[p.mora] || 0) && HIRAGANA[p.mora] && HIRAGANA[p.confuser]) return p;
  }
  return null;
}
function nativeQuestion() {
  const p = nextNativePair();
  if (p) { askChoices(p.mora, p.idx, shuffle([p.mora, p.confuser])); return; }
  // Batch spent (or not loaded yet): pull a fresh ranked batch, then try once more.
  choices.hidden = true; relisten.hidden = true; primary.hidden = true;
  tip.textContent = "読み込み中…";
  loadNativePairs().then(() => {
    const q = nextNativePair();
    if (q) { askChoices(q.mora, q.idx, shuffle([q.mora, q.confuser])); updateTip(); }   // restore the always-on advice after "読み込み中…"
    else { tip.textContent = "検証できるペアがまだありません"; primary.textContent = "再試行"; primary.hidden = false; }
  });
}

// Y/N quiz: play one mora, show one hiragana; the user decides whether they
// match. 50/50 the shown kana is the real target vs a random same-vowel sibling.
// Not fed into the grind tally (no choice set), and excluded from the dashboard.
function newYNQuestion(target, v) {
  const idx = pickVoice(target);
  const sibs = ALL.filter((m) => m !== target && m.endsWith(v));
  const displayed = (sibs.length === 0 || Math.random() < 0.5) ? target : pick(sibs);
  current = { target, idx, voice: path(target, idx), displayed, cap: 2, startTs: Date.now(), skill: skill[v] || 0, kind: "yn" };
  primary.hidden = true;
  relisten.hidden = false;   // a sound to replay exists now
  ynprompt.textContent = HIRAGANA[displayed];
  yn.hidden = false;
  play(current.voice);
}

// ○ = "yes, that's the sound" (correct iff shown kana is the target); ✕ = "no".
// asGuess (long-press) mirrors multi-choice guess(): a correct answer stays in
// review instead of auto-advancing, so the user can replay before moving on.
function ynSubmit(yes, asGuess = false) {
  if (!current || current.kind !== "yn" || locked) return;
  disarmRelisten();
  relisten.hidden = true;   // answered — nothing to replay until the next question
  const { target, idx, displayed, startTs, skill: level } = current;
  const correct = yes ? (displayed === target) : (displayed !== target);
  const now = Date.now();   // one read: ts and ms (= ts - startTs) stay consistent
  const ms = now - startTs;
  record(correct, target.slice(-1));
  pushEvent({ ts: now, target, idx, picked: displayed, cap: 2, ms, ev: yes ? "y" : "n", skill: level, start_ts: startTs });
  // Feed the day-start probe tally too, so a Y/N confusion drills like a
  // multi-choice one (same synthesis the dashboard matrix uses).
  const rec = confusionRecord({ ev: yes ? "y" : "n", target, picked: displayed });
  tallyAnswer(rec.target, rec.picked, rec.opts);
  const btn = yes ? ynyes : ynno;
  btn.classList.add(correct ? "correct" : "wrong");
  // Auto-advance only a plain correct ⚪︎ tap: the shown kana WAS the sound, so
  // there's nothing new to learn. Everything else stays in review so the ○/✕
  // buttons can replay the sound — a wrong answer, a long-press guess, or a
  // correct ✕ (where the played sound was never shown on screen).
  if (correct && !asGuess && displayed === target) {
    current = null;
    setTimeout(newQuestion, 650);
    return;
  }
  locked = true;
  // Reveal the actual sound whenever it wasn't the kana shown — every wrong
  // answer, and a correct ✕ — so the user connects ear to symbol. (A correct ⚪︎
  // guess that lingers needs no reveal: the kana on screen already was it.)
  if (!correct || displayed !== target) {
    ynactual.innerHTML = `actually: <strong>${HIRAGANA[target]}</strong>`;
    ynactual.hidden = false;
  }
  primary.textContent = "Next";
  primary.hidden = false;
  if (!correct) updateTip("review");
}

// In Y/N review (locked) the ○/✕ buttons replay a sound instead of answering, so
// the user can compare the two kana involved. ○ replays the kana shown on screen
// (what "yes" claims it is — on a wrong-kana question that's NOT the sound that
// played); ✕ replays the sound that actually played. For a correct-kana question
// (shown == target) they're the same. A short tap on ✕ replays the exact recording
// that played; the shown kana (which was never played) and any long-press play a
// random recording of their mora.
function replayYN(btn, random = false) {
  if (!current) return;
  for (const b of [ynyes, ynno]) b.classList.remove("playing");
  btn.classList.add("playing");
  audio.onended = () => { btn.classList.remove("playing"); audio.onended = null; };
  const { target, idx, displayed, cap, startTs } = current;
  const mora = btn === ynyes ? displayed : target;
  const i = (mora === target && !random) ? idx : rand(mora);
  play(path(mora, i));
  const now = Date.now();
  pushEvent({ ts: now, target, idx: i, picked: mora, cap, ms: now - startTs, ev: "p", start_ts: startTs });
}

// Long-press = "guess": if right, counts as correct but stays in review mode
// (no auto-advance) so the user can re-listen before moving on.
const LONG_MS = 500;
let pressTimer = null;
let longHandled = false;

choices.onpointerdown = (e) => {
  const btn = e.target.closest(".choice");
  if (!btn) return;
  // Always reset on a fresh press: if the post-long-press click didn't
  // fire (common on touch), the flag would otherwise eat the next tap.
  longHandled = false;
  if (!current) return;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longHandled = true;
    if (locked) replay(btn.dataset.mora, btn, true);   // random sample
    else guess(btn);
  }, LONG_MS);
};
const cancelPress = () => {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
};
choices.onpointerup = cancelPress;
choices.onpointercancel = cancelPress;
choices.onpointerleave = cancelPress;

choices.onclick = (e) => {
  const btn = e.target.closest(".choice");
  if (!btn || !current) return;
  if (longHandled) { longHandled = false; return; }
  const m = btn.dataset.mora;
  if (locked) replay(m, btn);
  else submit(m, btn);
};

// The Y/N ○/✕ buttons share the same press machinery as the choice buttons:
// short tap = answer (or, in review, replay the same voice); long-press = guess
// (or, in review, replay a different voice).
ynbuttons.onpointerdown = (e) => {
  const btn = e.target.closest(".choice.yn");
  if (!btn) return;
  longHandled = false;
  if (!current) return;
  const yes = btn === ynyes;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longHandled = true;
    if (locked) replayYN(btn, true);   // different voice
    else ynSubmit(yes, true);          // guess
  }, LONG_MS);
};
ynbuttons.onpointerup = cancelPress;
ynbuttons.onpointercancel = cancelPress;
ynbuttons.onpointerleave = cancelPress;

ynbuttons.onclick = (e) => {
  const btn = e.target.closest(".choice.yn");
  if (!btn || !current) return;
  if (longHandled) { longHandled = false; return; }
  if (locked) replayYN(btn);
  else ynSubmit(btn === ynyes);
};

function guess(btn) {
  disarmRelisten();
  relisten.hidden = true;   // answered — nothing to replay until the next question
  const picked = btn.dataset.mora;
  const { target, idx, cap, startTs, opts, skill: level } = current;
  if (picked !== target) { submit(picked, btn, true); return; }
  const now = Date.now();
  const ms = now - startTs;
  record(true, target.slice(-1));
  tallyAnswer(target, picked, opts);
  pushEvent({ ts: now, target, idx, picked, cap, ms, ev: "g", opts, skill: level, start_ts: startTs });
  btn.classList.add("correct");
  locked = true;
  primary.textContent = "Next";
  primary.hidden = false;
}

function replay(m, btn, random = false) {
  for (const b of choices.querySelectorAll(".choice.playing")) b.classList.remove("playing");
  btn.classList.add("playing");
  audio.onended = () => { btn.classList.remove("playing"); audio.onended = null; };
  const i = random ? rand(m) : +btn.dataset.idx;
  play(path(m, i));
  const { target, cap, startTs } = current;
  // For 'p' events, idx describes what was *played*: the voice sample of the tapped
  // mora `m` (= picked). The question's own voice is on its sibling 'a'/'g' event,
  // paired by the shared start_ts (the per-question key). See worker/schema.sql.
  const now = Date.now();
  pushEvent({ ts: now, target, idx: i, picked: m, cap, ms: now - startTs, ev: "p", start_ts: startTs });
}

function submit(picked, btn, wasGuess = false) {
  disarmRelisten();
  relisten.hidden = true;   // answered — nothing to replay until the next question
  const { target, idx, cap, startTs, opts, skill: level } = current;
  const correct = picked === target;
  const now = Date.now();
  const ms = now - startTs;
  record(correct, target.slice(-1));
  tallyAnswer(target, picked, opts);
  pushEvent({ ts: now, target, idx, picked, cap, ms, ev: wasGuess ? "g" : "a", opts, skill: level, start_ts: startTs });
  if (correct) {
    btn.classList.add("correct");
    current = null;                          // lock out further clicks
    setTimeout(newQuestion, 650);            // hold the green flash long enough to read
  } else {
    locked = true;
    for (const b of choices.children) {
      if (b.dataset.mora === target) b.classList.add("correct");
      else if (b.dataset.mora === picked) b.classList.add("wrong");
    }
    primary.textContent = "Next";
    primary.hidden = false;
    updateTip("review");
  }
}

// Hide and disarm the re-listen confirm balloon. Called whenever we leave the
// awaiting-answer state — a new question starts or the current one is answered
// — so the balloon never lingers into answer review.
function disarmRelisten() {
  relistenArmed = false;
  relistenwarn.hidden = true;
}

// Re-listen replays the current question. At cap=2 (lowest level) it's free
// — no skill / streak penalty and not even recorded. From cap=3 up it costs
// the vowel's in-level skill and breaks the streak, so the first tap shows
// a warning balloon and only a second tap actually re-listens. The balloon
// only warns about the streak, so when there's no streak to lose (run === 0)
// it's skipped and the first tap re-listens straight away.
function relistenCurrent() {
  if (!current) return;
  const { target, idx, cap, startTs } = current;

  if (cap <= 2) {
    // Free re-listen — beginner-friendly at the lowest level. Skip the
    // event entirely so the server doesn't replay a phantom penalty.
    play(current.voice);
    return;
  }

  if (run > 0 && !relistenArmed) {
    relistenArmed = true;
    relistenwarn.hidden = false;
    return;
  }
  disarmRelisten();

  applyRelisten(target.slice(-1));
  save();
  render();
  const now = Date.now();
  pushEvent({ ts: now, target, idx, picked: "", cap, ms: now - startTs, ev: "r", start_ts: startTs });
  play(current.voice);
}

// ---------- input ----------
primary.onclick = newQuestion;
relisten.onclick = relistenCurrent;

onkeydown = (e) => {
  if (e.key === " " || e.key === "Enter") {
    if (!primary.hidden) primary.click();
    else if (current && !locked) relistenCurrent();
    else return;
    e.preventDefault();
  } else if (/^[1-9]$/.test(e.key)) {
    if (current?.kind === "yn") [ynyes, ynno][+e.key - 1]?.click();
    else choices.children[+e.key - 1]?.click();
  }
};

// Replay another user's event history into local state (view-as mode).
// Stats are bucketed by the event's local date in the *viewer's* timezone,
// which may drift slightly from the original user's bucketing — close enough
// for a debug tool.
async function loadAsUser(targetUid) {
  const res = await fetch(STATS_URL + "/v1/user/" + encodeURIComponent(targetUid) + "/events");
  if (!res.ok) { console.error("view-as: fetch failed", res.status); return; }
  const { events } = await res.json();
  events.sort((a, b) => a.ts - b.ts);
  stats = {}; skill = {}; run = 0;
  let lastDay = null;
  for (const e of events) {
    if (!["a", "g", "r", "y", "n"].includes(e.ev)) continue;
    const k = dateKey(new Date(e.ts));
    if (lastDay !== null && k !== lastDay) run = 0;   // day boundary resets streak
    lastDay = k;
    const v = e.target.slice(-1);
    if (e.ev === "r") { applyRelisten(v); continue; }
    // Y/N 'n' inverts correctness: a correct "no" means the shown kana wasn't it.
    applyAnswer(k, v, e.ev === "n" ? e.picked !== e.target : e.picked === e.target);
  }
  render();
}

// Nickname: prompt for one (unless already set) and persist it locally + to
// /v1/user. `extra` carries optional fields (e.g. role for the native-tester
// opt-in). Returns the nickname now in effect. Ignored in view-as mode so you
// can't rename someone you're inspecting. Reused by the ?nativeTester flow.
function promptForNick(message, extra) {
  if (viewMode || !STATS_URL) return localStorage.nick || null;
  if (!localStorage.nick) {
    const nick = (prompt(message) || "").trim().slice(0, 64);
    if (nick) localStorage.nick = nick;
  }
  // POST when there's a nickname to record or an extra field (role) to apply —
  // a returning native tester keeps their nick but still needs the role set.
  if (localStorage.nick || extra) {
    fetch(STATS_URL + "/v1/user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid, nickname: localStorage.nick || "", tz: -new Date().getTimezoneOffset(), ...extra }),
    }).catch(() => { });
  }
  return localStorage.nick || null;
}

// ?nick opens a one-time prompt to set your nickname (unless one is already set).
if (new URLSearchParams(location.search).has("nick")) {
  promptForNick("Set a nickname (shown to the site admin):");
}

// ?nativeTester: opt into native-tester mode — a Japanese nickname prompt, set
// role 2 server-side, and flag this device so the special drilling mode persists
// across visits (no need to revisit the secret URL).
if (!viewMode && new URLSearchParams(location.search).has("nativeTester")) {
  promptForNick("ニックネームを入力してください（管理者に表示されます）:", { role: 2 });
  localStorage.nativeMode = "1";
  nativeMode = true;
}

// Nudge a reload once a newer build has shipped — a PWA can otherwise run a stale
// cached bundle for a while (that's how the tz feature missed early users). Checks
// on load and whenever the tab refocuses; reload busts the HTTP cache via the
// document's etag. No-op in view-as and for 'dev' builds. (No polling timer — it'd
// keep the event loop alive and hang the test runner; refocus covers the rest.)
function watchForUpdate() {
  if (viewMode) return;
  const bar = updatebar;   // hold the node so the async check can't throw on a vanished global post-teardown
  updatereload.onclick = () => location.reload();
  const check = () => updateAvailable().then((stale) => { if (stale) bar.hidden = false; });
  check();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
}

// ---------- boot ----------
watchForUpdate();
if (viewMode) {
  stats = {}; run = 0; skill = {};
  tip.textContent = `(view-as: ${spoofedUid})`;
  dashlink.href = "dashboard/?uid=" + encodeURIComponent(spoofedUid);   // keep view-as context on the dashboard link too
  render();
  loadAsUser(spoofedUid);
} else {
  const t = load();
  stats = t.s || {};
  run = t.k || 0;
  skill = t.x || {};
  updateTip();
  initGrind();
  render();
  flushEvents();
  scheduleReminders();
  if (nativeMode) loadNativePairs();   // prefetch the first ranked batch
}
