import { capFor, onCorrect, onWrong, onRelisten } from "../shared/skill.js";
import { dateKey, daysAgo } from "../shared/dates.js";
import { TIPS } from "./tips.js";
import { getGrind, tallyAnswer, initGrind, recordGrindAnswer } from "./grind.js";
import { scheduleReminders } from "./reminders.js";
import { render } from "./render.js";

// Mora identifiers are kunrei-shiki (ASCII) so audio URLs stay plain ASCII;
// the vowel is just the last letter (sa→a, sya→a, ti→i). HIRAGANA maps each
// id to its hiragana for the buttons; ALL is just its key list. The build
// injects window.VOICE_COUNTS = {mora: n}; audio lives at audio/<vowel>/<mora>/<i>.opus.
const HIRAGANA = {
  sa: "さ", za: "ざ", sya: "しゃ", zya: "じゃ", tya: "ちゃ",
  si: "し", zi: "じ", ti: "ち",
  su: "す", zu: "ず", tu: "つ", syu: "しゅ", zyu: "じゅ", tyu: "ちゅ",
  so: "そ", zo: "ぞ", syo: "しょ", zyo: "じょ", tyo: "ちょ",
};
const ALL = Object.keys(HIRAGANA);
const COUNTS = window.VOICE_COUNTS;

export const DAYS = 30;
export const BAR_MAX = 50;     // a day with 50+ answers fills the bar to the top
export const emptyDay = () => ({ correct: 0, total: 0, maxRun: 0 });

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
const STATS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
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
const uid = spoofedUid || (localStorage.uid ||= crypto.randomUUID());
let evQueue = [];
try { evQueue = JSON.parse(localStorage.ev_queue || "[]"); } catch { }

function pushEvent(ev) {
  if (!STATS_URL || viewMode) return;
  evQueue.push(ev);
  localStorage.ev_queue = JSON.stringify(evQueue);
  flushEvents();
}

let flushing = false;
async function flushEvents() {
  if (!STATS_URL || flushing || evQueue.length === 0) return;
  flushing = true;
  const batch = evQueue.slice(0, 100);
  try {
    const res = await fetch(STATS_URL + "/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid, events: batch }),
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

function record(correct, vowel) {
  // Midnight rollover: if today's bucket doesn't exist yet but other days
  // do, the streak from the most recent day is stale — same reset rule as
  // load() applies, just from a long-open session crossing midnight.
  const todayKey = daysAgo(0);
  if (!stats[todayKey] && Object.keys(stats).length > 0) run = 0;
  applyAnswer(todayKey, vowel, correct);
  const cutoff = daysAgo(DAYS - 1);
  for (const x of Object.keys(stats)) if (x < cutoff) delete stats[x];
  recordGrindAnswer();
  save();
  render();
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
function play(src) {
  audio.src = src;
  audio.currentTime = 0;
  audio.play().catch(() => { });
}

function newQuestion() {
  locked = false;
  disarmRelisten();
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
    const sibs = ALL.filter((m) => m !== target && m.endsWith(v));
    opts = shuffle([target, ...shuffle(sibs).slice(0, cap - 1)]);
  }
  const idx = rand(target);
  // skill = the target vowel's level (correct-count) at question time — frozen
  // into the event so changing the level rules can't rewrite history.
  current = { target, idx, voice: path(target, idx), cap: opts.length, startTs: Date.now(), opts, skill: skill[target.slice(-1)] || 0 };
  primary.hidden = true;
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

function guess(btn) {
  disarmRelisten();
  const picked = btn.dataset.mora;
  const { target, idx, cap, startTs, opts, skill: level } = current;
  if (picked !== target) { submit(picked, btn, true); return; }
  const ms = Date.now() - startTs;
  record(true, target.slice(-1));
  tallyAnswer(target, picked, opts);
  pushEvent({ ts: Date.now(), target, idx, picked, cap, ms, ev: "g", opts, skill: level });
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
  // For 'p' events, idx describes what was *played*: the voice sample of the
  // tapped mora `m` (= picked). The question's voice is implicit via the
  // sibling 'a'/'g' event at (uid, target, ts - ms). See worker/schema.sql.
  pushEvent({ ts: Date.now(), target, idx: i, picked: m, cap, ms: Date.now() - startTs, ev: "p" });
}

function submit(picked, btn, wasGuess = false) {
  disarmRelisten();
  const { target, idx, cap, startTs, opts, skill: level } = current;
  const correct = picked === target;
  const ms = Date.now() - startTs;
  record(correct, target.slice(-1));
  tallyAnswer(target, picked, opts);
  pushEvent({ ts: Date.now(), target, idx, picked, cap, ms, ev: wasGuess ? "g" : "a", opts, skill: level });
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
  pushEvent({ ts: Date.now(), target, idx, picked: "", cap, ms: Date.now() - startTs, ev: "r" });
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
    choices.children[+e.key - 1]?.click();
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
    if (e.ev !== "a" && e.ev !== "g" && e.ev !== "r") continue;
    const k = dateKey(new Date(e.ts));
    if (lastDay !== null && k !== lastDay) run = 0;   // day boundary resets streak
    lastDay = k;
    const v = e.target.slice(-1);
    if (e.ev === "r") applyRelisten(v);
    else applyAnswer(k, v, e.picked === e.target);
  }
  render();
}

// ?nick=Foo sets your own nickname (sends to /v1/user, persists locally).
// Ignored in view-as mode so you can't accidentally rename someone else.
const nickParam = new URLSearchParams(location.search).get("nick");
if (!viewMode && STATS_URL && nickParam !== null) {
  const nick = nickParam.trim().slice(0, 64);
  localStorage.nick = nick;
  if (nick) {
    fetch(STATS_URL + "/v1/user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid, nickname: nick }),
    }).catch(() => { });
  }
}

// ---------- boot ----------
if (viewMode) {
  stats = {}; run = 0; skill = {};
  tip.textContent = `(view-as: ${spoofedUid})`;
  render();
  loadAsUser(spoofedUid);
} else {
  const t = load();
  stats = t.s || {};
  run = t.k || 0;
  skill = t.x || {};
  tip.textContent = pick(TIPS);
  initGrind();
  render();
  flushEvents();
  scheduleReminders();
}
