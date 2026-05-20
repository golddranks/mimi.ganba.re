// Mora identifiers are kunrei-shiki (ASCII) so audio URLs stay plain ASCII;
// the vowel is just the last letter (sa→a, sya→a, ti→i). DISPLAY maps each
// id to its hiragana for the buttons. The build injects window.VOICE_COUNTS
// = {mora: n}; audio lives at audio/<vowel>/<mora>/<i>.opus.
const ALL = [
  "sa", "za", "sya", "zya", "tya",
  "si", "zi", "ti",
  "su", "zu", "tu", "syu", "zyu", "tyu",
  "so", "zo", "syo", "zyo", "tyo",
];
const DISPLAY = {
  sa: "さ", za: "ざ", sya: "しゃ", zya: "じゃ", tya: "ちゃ",
  si: "し", zi: "じ", ti: "ち",
  su: "す", zu: "ず", tu: "つ", syu: "しゅ", zyu: "じゅ", tyu: "ちゅ",
  so: "そ", zo: "ぞ", syo: "しょ", zyo: "じょ", tyo: "ちょ",
};
const COUNTS = window.VOICE_COUNTS;

const DAYS = 30;
const BAR_MAX = 50;            // a day with 50+ answers fills the bar to the top
const LOG_MAX = 2000;          // localStorage.mora_log, newline-separated
// Per-vowel level thresholds: correct count in a vowel group unlocks more
// distractors. Wrong answers drop the count just below the current step.
const LEVELS = [10, 15, 20];   // cap = 2 + (thresholds crossed) → 2/3/4/5
const Z = () => ({ correct: 0, total: 0 });
const pad2 = (x) => ("0" + x).slice(-2);

// Elements with id attributes are auto-exposed on window (primary, choices,
// message, score, streak, audio, topbar).
let stats = {};                // {YYYY-MM-DD: {correct,total}}
let run = 0;                   // running streak of correct answers
let skill = {};                // {vowel: count} — persistent per-vowel level counter
let current = null;            // {target, voice}
let locked = false;            // true while reviewing a wrong answer

// ---------- persistence ----------
function load() {
  try { return JSON.parse(localStorage.mora) || {}; }
  catch { return {}; }
}
const save = () => localStorage.mora = JSON.stringify({ s: stats, k: run, x: skill });

// Compact answer log persisted across sessions; capped at LOG_MAX entries.
// Format per line:
//   <YYYY-MM-DD HH:MM:SS> <target>/<voiceIdx>           (correct)
//   <YYYY-MM-DD HH:MM:SS> <target>/<voiceIdx> <picked>  (wrong)
// Exposed as window.log for inspection from DevTools.
const log = (localStorage.mora_log || "").split("\n").filter(Boolean);
window.log = log;
if (log.length) console.log(log.join("\n"));    // dump history on page load
function appendLog(target, idx, picked) {
  const entry = `${nowStamp()} ${target}/${idx}` + (picked === target ? "" : ` ${picked}`);
  log.push(entry);
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  localStorage.mora_log = log.join("\n");
  console.log(entry);
}

// ---------- dates: YYYY-MM-DD for n days ago ----------
function key(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function nowStamp() {
  const d = new Date();
  return `${key(0)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ---------- stats ----------
const today = () => stats[key(0)] || Z();
const acc = (s) => s.total ? s.correct / s.total : 0;

function record(correct, vowel) {
  const s = (stats[key(0)] ||= Z());
  s.total++;
  if (correct) {
    s.correct++;
    skill[vowel] = (skill[vowel] || 0) + 1;
    run++;
  } else {
    const c = skill[vowel] || 0;
    const i = LEVELS.findLastIndex((t) => c >= t);
    skill[vowel] = i < 0 ? 0 : LEVELS[i] - 1;
    run = 0;
  }
  const cutoff = key(DAYS - 1);
  for (const x of Object.keys(stats)) if (x < cutoff) delete stats[x];
  save();
  render();
}

function mastered() {
  const days = Object.keys(stats).filter((k) => stats[k].total).sort();
  if (!days.length) return false;
  // Tier 1: first ever day, completed at 100%.
  if (days.length === 1) {
    const s = stats[days[0]];
    return s.correct === s.total && doneToday();
  }
  // Tier 2: first 5 trained days all >=95%.
  if (days.length >= 5 && days.slice(0, 5).every((k) => acc(stats[k]) >= .95)) return true;
  // Tier 3: in the last 30 days, >=22 days trained and every trained day >=95%.
  const w = Array.from({ length: DAYS }, (_, i) => stats[key(i)]).filter((s) => s?.total);
  return w.length >= 22 && w.every((s) => acc(s) >= .95);
}

// Returns "ace" (high accuracy / streak), "grind" (sheer volume), or null.
const doneToday = () => {
  const s = today();
  if (s.total >= 50 && acc(s) >= .95 || run >= 30) return "ace";
  if (s.total >= 100) return "grind";
  return null;
};

// ---------- rendering ----------
function render() {
  const s = today();
  score.textContent = `${s.correct} correct out of ${s.total}`;
  streak.hidden = run < 2;
  streak.textContent = `streak: ${run}`;

  let cls = "", text = "Let's train some more today!";
  if (mastered()) {
    cls = "mastered";
    text = "You mastered this. Maybe try learning something else?";
  } else {
    const mode = doneToday();
    if (mode === "ace") {
      cls = "done";
      text = "You are doing good! That's enough for today! Come again tomorrow!";
    } else if (mode === "grind") {
      cls = "done";
      text = "Putting the work in! That's enough for today! Come again tomorrow!";
    }
  }
  message.className = cls;
  message.textContent = text;

  renderBar();
}

function renderBar() {
  const t = key(0);
  let html = "";
  for (let i = DAYS - 1; i >= 0; i--) {
    const k = key(i);
    const s = stats[k] || Z();
    const isT = k === t;
    const cls = "bar-bin" + (isT ? " today" : "") + (isT && !s.total ? " empty" : "");
    const inner = s.total
      ? `<div class="bar-stack" style="height:${Math.min(100, s.total / BAR_MAX * 100)}%">`
      + `<div class="bar-correct" style="height:${s.correct / s.total * 100}%"></div></div>`
      : "";
    html += `<div class="${cls}" title="${k}  ${s.correct} correct out of ${s.total}">${inner}</div>`;
  }
  topbar.innerHTML = html;
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
  const target = pick(ALL);
  // Stay strictly within the target's vowel group (last char of kunrei).
  // The cap is a maximum; small groups (e.g. i has only si/zi/ti) give fewer.
  // Level is tracked per vowel group: each group ramps up independently.
  const v = target.slice(-1);
  const c = skill[v] || 0;
  const cap = 2 + LEVELS.filter((t) => c >= t).length;
  const sibs = ALL.filter((m) => m !== target && m.endsWith(v));
  const opts = shuffle([target, ...shuffle(sibs).slice(0, cap - 1)]);
  const idx = rand(target);
  current = { target, idx, voice: path(target, idx) };
  primary.hidden = true;
  choices.dataset.n = opts.length;
  choices.innerHTML = opts
    .map((m) => `<button class="choice" data-mora="${m}">${DISPLAY[m]}</button>`)
    .join("");
  choices.hidden = false;
  play(current.voice);
}

choices.onclick = (e) => {
  const btn = e.target.closest(".choice");
  if (!btn || !current) return;
  const m = btn.dataset.mora;
  if (locked) replay(m, btn);
  else submit(m, btn);
};

function replay(m, btn) {
  for (const b of choices.querySelectorAll(".choice.playing")) b.classList.remove("playing");
  btn.classList.add("playing");
  audio.onended = () => { btn.classList.remove("playing"); audio.onended = null; };
  // Correct choice replays the exact question clip; distractors play a fresh sample.
  play(m === current.target ? current.voice : path(m, rand(m)));
}

function submit(picked, btn) {
  const { target, idx } = current;
  const correct = picked === target;
  record(correct, target.slice(-1));
  appendLog(target, idx, picked);
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

// ---------- input ----------
primary.onclick = newQuestion;

onkeydown = (e) => {
  if (e.key === " " || e.key === "Enter") {
    if (!primary.hidden) primary.click();
    else if (current && !locked) play(current.voice);
    else return;
    e.preventDefault();
  } else if (/^[1-9]$/.test(e.key)) {
    choices.children[+e.key - 1]?.click();
  }
};

// ---------- boot ----------
const t = load();
stats = t.s || {};
run = t.k || 0;
skill = t.x || {};
render();
