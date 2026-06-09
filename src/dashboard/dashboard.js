import { LEVELS, levelIdx, capFor, onCorrect, onWrong, onRelisten } from "../shared/skill.js";
import { pad2, dayKeyTz } from "../shared/dates.js";
import { confusionTargets, logisticTrend, logisticAt, aggregateByConsonant, consonantCounts, fillConfusionCells } from "../shared/confusion.js";
import { tallyFromEvents, tallyMaps, confusionMaps, confusionRecord, confusionExtras } from "../shared/tally.js";
import { HIRAGANA } from "../shared/kana.js";
import { isAnswerEv, answeredRight, isPenalizedRelisten } from "../shared/events.js";
import { pushSupported, currentSubscription, subscribe, unsubscribe } from "../shared/push.js";
import { dayBarChart, dayTip, calendarSpan } from "../shared/daychart.js";
import { drawBars, drawHourly, wireSwitchGroup } from "../shared/charts.js";
import { drawVoiceConfusion as renderVoiceConf, playVoice } from "../shared/voiceconf.js";

// Read-only per-user dashboard. Pulls events from the stats worker and renders
// a handful of visualizations. No localStorage writes, no event posts.
//
// The page's static structure (overview tiles, per-mora rows, confusion matrix
// grids) lives in dashboard.html; the JS here only fills in values. The SVG
// charts (daily/hourly/streak/reaction-time) are dynamic in shape and built
// here.

// When served from localhost (via scripts/dev.sh) hit the local wrangler dev
// worker so the dashboard reflects local-DB events rather than production.
const STATS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? `http://${location.hostname}:8787`
  : "https://mimi-stats.golddranks.workers.dev";

// Event-kind predicates: a/g and Y/N (y/n) are answers; 'r' is a re-listen; 'p'
// is an after-play replay (never counted here). isAnswerEv + answeredRight (with
// the Y/N "no" correctness inversion) are shared with the worker and push, so
// "activity" and accuracy mean the same thing everywhere.
const isAnswer = (e) => isAnswerEv(e.ev);
const isAnswerOrRelisten = (e) => isAnswer(e) || e.ev === "r";

// Two roles:
//   viewer  — whose browser this is (localStorage.uid set by the main app)
//   viewed  — whose dashboard to render (?uid=… overrides; otherwise the
//             viewer themselves, so the default landing is "look at me").
// The uid-load form is only revealed if the viewer is a power_user. Normal
// users always see their own dashboard with no foot-shotgun for typing
// other people's uids in.
const params = new URLSearchParams(location.search);
const viewerUid = localStorage.getItem("uid") || "";
const uid = params.get("uid") || viewerUid;

// Day/hour bucketing frame: the *viewed* user's tz (minutes east of UTC), set from
// their events response in load(). Defaults to the viewer's own browser offset —
// correct on your own dashboard, and the fallback when a user has no tz on record.
// tzKnown distinguishes "their reported tz" from that fallback (for the hour label).
let viewedTzMin = -new Date().getTimezoneOffset();
let tzKnown = false;

// Capture the elements that async callbacks (the form reveal, renderReminders, the
// view-as gate) touch after a fetch resolves. Holding the node means a callback
// that lands after navigation still sets a (now-detached) element instead of
// throwing on a window global that's gone — which in tests surfaces as an
// "uidform/reminders is not defined" rejection when the page is torn down mid-fetch.
const uidform = document.getElementById("uidform");
const statslink = document.getElementById("statslink");
const reminders = document.getElementById("reminders");
const reminderstatus = document.getElementById("reminderstatus");
const reminderbtn = document.getElementById("reminderbtn");
const retention = document.getElementById("retention");
const nativebadge = document.getElementById("nativebadge");
const msg = document.getElementById("msg");
const dash = document.getElementById("dash");

// Carry an explicit ?uid= back to the app so "back" stays in view-as mode for
// that user. Without one (you're looking at your own dashboard), back goes to
// the app's own localStorage-backed state.
if (params.get("uid")) {
  document.querySelector(".back").href = "../?uid=" + encodeURIComponent(params.get("uid"));
}

uidform.onsubmit = (e) => {
  e.preventDefault();
  const v = uidinput.value.trim();
  if (!v) return;
  location.search = "?uid=" + encodeURIComponent(v);
};

// Viewer's power level (cached promise): drives the view-as gate, the uid-load
// form, and the reminder readout. The resolved level is also remembered in
// localStorage so the form can reveal synchronously next time (see below).
let viewerLevelP;
const viewerLevel = () => (viewerLevelP ||= viewerUid
  ? fetch(STATS_URL + "/v1/user/" + encodeURIComponent(viewerUid))
      .then((r) => r.ok ? r.json() : null)
      .then((i) => { const l = (i && i.power_user) || 0; localStorage.dashLevel = l; return l; })
      .catch(() => 0)
  : Promise.resolve(0));

// Seed the count/% toggle from its restored-or-default state and wire changes —
// before the first load() renders, so the initial view reflects the control (the
// browser persists it across a soft reload, like the filter inputs; a hard reload
// starts at the default).
let displayMode = wireSwitchGroup(document.querySelectorAll('[data-switch="mode"]'), (m) => {
  displayMode = m;
  drawConfusion();
  drawMora();
  drawConsMora();
  drawVoiceConf();
});

if (uid) {
  uidinput.value = uid;
  if (uid === viewerUid) {
    load(uid);                       // your own dashboard — always allowed
  } else {
    // Viewing someone else's dashboard is a power-user feature (>= 1): knowing a
    // uid isn't enough to snoop on another person. Own data needs no power.
    viewerLevel().then((level) => {
      if (level >= 1) { load(uid); return; }
      msg.textContent = "Unauthorized — viewing another user's dashboard requires power-user access.";
      dash.style.display = "none";
    });
  }
}

// ---------- daily-reminder notifications ----------
// On your own dashboard: this device's push-subscription state and a turn-on/off
// button (subscribe/unsubscribe shared with the app's opt-in, shared/push.js).
// In a ?uid= view-as: a read-only "on/off" for that uid (any of their devices
// subscribed), shown to a power user (>= 1, same as the view-as gate) — never a
// toggle for someone else's reminders.
// View-as reminder readout from the server's { on, state } — filled by load().
const reminderReadout = (on, state) =>
  on ? "Daily reminders: on for this user."
    : state === "declined" ? "Daily reminders: declined by this user."
      : state === "offered" ? "Daily reminders: offered, no answer yet."
        : "Daily reminders: not offered to this user yet.";

async function renderReminders() {
  reminderbtn.hidden = true;
  // View-as: the readout is fetched + filled by load() (the dashboard's own data
  // load), since the viewed user's state isn't this device's to cache. Reserve its
  // line here from the cached own power level so it doesn't shift in; a non-power
  // viewer has #dash (and this with it) hidden by the gate.
  if (uid !== viewerUid) {
    if (+localStorage.dashLevel >= 1) { reminderstatus.textContent = "Daily reminders: …"; reminders.hidden = false; }
    return;
  }
  if (!viewerUid) { reminders.hidden = true; return; }

  reminders.hidden = false;
  if (!pushSupported()) {
    reminderstatus.textContent = "Reminders: not supported in this browser.";
    return;
  }
  if (Notification.permission === "denied") {
    reminderstatus.textContent = "Reminders: blocked in your browser settings.";
    return;
  }
  const showState = (on) => {
    reminderbtn.hidden = false;
    reminderstatus.textContent = on
      ? "Daily reminders are on for this device."
      : localStorage.remind_optout
        ? "Daily reminders are off (you dismissed them)."
        : "Daily reminders are off.";
    reminderbtn.textContent = on ? "Turn off" : "Turn on";
  };
  // Render from the remembered state first (synchronous, before first paint), so
  // the status doesn't flash in after the async getSubscription on every refresh;
  // then confirm/correct from the actual subscription and remember it.
  showState(localStorage.remindOn === "1");
  const sub = await currentSubscription();
  localStorage.remindOn = sub ? "1" : "0";
  showState(!!sub);
}

reminderbtn.onclick = async () => {
  reminderbtn.disabled = true;
  try {
    if (await currentSubscription()) {
      await unsubscribe(STATS_URL);
      localStorage.remind_optout = "1";   // explicit off — don't let the app re-nag
    } else if (await Notification.requestPermission() === "granted") {
      delete localStorage.remind_optout;
      await subscribe(viewerUid, STATS_URL);
    }
  } catch { /* best-effort */ }
  reminderbtn.disabled = false;
  renderReminders();
};

renderReminders();

// Reveal the load-form only at level 2. View-as itself works at level 1 (so a
// shared ?uid= link opens), but the form — typing in arbitrary uids — is useless
// below level 2: uids are only obtainable from the DB or the level-2 admin page.
// Showing it to level-1 users would just invite snooping with uids they can't get.
//
// Reveal it synchronously from the remembered level first (this script runs
// before first paint), so it doesn't flash in after the async check on every
// refresh; the check then confirms or corrects (and records the level).
// The aggregate-stats (/stats/) link is a level-1 feature, same gate as view-as;
// it carries no uid (the page authorises by the viewer's own uid). Same synchronous
// reveal-from-cache as the form, confirmed by the async check.
if (viewerUid && +localStorage.dashLevel >= 1) statslink.hidden = false;
if (viewerUid && +localStorage.dashLevel >= 2) uidform.hidden = false;
viewerLevel().then((level) => { statslink.hidden = level < 1; uidform.hidden = level < 2; });

// First paint shows the dash skeleton (zeros + reserved chart space). #msg
// stays empty (and therefore display:none) during the loading window, so the
// dash doesn't shift when we'd otherwise hide a "Loading…" line. CSS handles
// the no-uid prompt via ::before; JS only writes to #msg for error states.
async function load(uid) {
  try {
    // View-as (uid ≠ viewer): the gate above only reaches here for a power viewer,
    // so fetch the viewed user's reminder state alongside their events and fill the
    // readout with the rest of the dashboard — no separate late fetch, no caching.
    const viewAs = uid !== viewerUid;
    const [res, remRes] = await Promise.all([
      fetch(STATS_URL + "/v1/user/" + encodeURIComponent(uid) + "/events"),
      viewAs ? fetch(STATS_URL + "/v1/admin/reminder?uid=" + encodeURIComponent(viewerUid)
        + "&target=" + encodeURIComponent(uid)).catch(() => null) : Promise.resolve(null),
    ]);
    if (viewAs && remRes && remRes.ok) {
      const { on, state } = await remRes.json();
      reminderstatus.textContent = reminderReadout(on, state);
      reminders.hidden = false;
    }
    if (!res.ok) { msg.textContent = `Fetch failed: HTTP ${res.status}`; return; }
    const { events, tz_offset, delete_after, role } = await res.json();
    if (tz_offset != null) { viewedTzMin = tz_offset; tzKnown = true; }
    if (delete_after != null) { setStat("kept", dayKeyTz(delete_after, viewedTzMin)); retention.hidden = false; }
    if (role === 2) nativebadge.hidden = false;
    events.sort((a, b) => a.ts - b.ts);
    if (events.length === 0) {
      msg.textContent = "No events for this user.";
      return;
    }
    renderOverview(uid, events);
    renderLevels(events);
    renderDaily(events);
    renderHourly(events);
    renderMora(events);
    renderConfusion(events);
    renderVoiceConfusion(events);
    checkTallyDrift(events);
    renderStreak(events);
    renderRtime(events);
  } catch (e) {
    msg.textContent = "Error: " + (e && e.message);
  }
}

// ---------- overview ----------
const setStat = (k, v) => overview.querySelector(`[data-stat="${k}"]`).textContent = v;

// Per-day peak correct-streak. run resets on a wrong answer, a re-listen, or a
// day boundary — the live app's rules (see app.js record()), so the all-time
// top streak (max of the peaks) matches what the user saw in #streak.
function dailyPeakStreaks(events) {
  const peaks = new Map();          // YYYY-MM-DD → max run that day
  let run = 0, lastDay = null;
  for (const e of events) {
    if (!isAnswerOrRelisten(e)) continue;
    const d = dayKeyTz(e.ts, viewedTzMin);
    if (lastDay !== null && d !== lastDay) run = 0;
    lastDay = d;
    if (e.ev === "r") { if (isPenalizedRelisten(e)) run = 0; }   // free re-listens don't break the streak
    else if (answeredRight(e)) run++;
    else run = 0;
    if (run > (peaks.get(d) || 0)) peaks.set(d, run);
  }
  return peaks;
}

function renderOverview(uid, events) {
  const ag = events.filter(isAnswer);
  const correct = ag.filter((e) => answeredRight(e)).length;
  const acc = ag.length ? correct / ag.length : 0;
  const topStreak = Math.max(0, ...dailyPeakStreaks(events).values());
  const days = new Set(ag.map((e) => dayKeyTz(e.ts, viewedTzMin))).size;
  const relisten = events.filter((e) => e.ev === "r").length;

  overview.querySelector(".uid .uid-value").textContent = uid;
  setStat("answers", ag.length);
  setStat("correct", correct);
  setStat("accuracy", (acc * 100).toFixed(1) + "%");
  setStat("topstreak", topStreak);
  setStat("days", days);
  setStat("relisten", relisten);
  setStat("first", dayKeyTz(events[0].ts, viewedTzMin));
  setStat("last", dayKeyTz(events[events.length - 1].ts, viewedTzMin));
}

// ---------- skill levels per vowel ----------
// Skill state machine is shared with the app + worker (see src/shared/skill.js);
// here we just replay it over the fetched events.
const LEVEL_MAX = LEVELS[LEVELS.length - 1];

function renderLevels(events) {
  const skill = { a: 0, i: 0, u: 0, o: 0 };
  const seen = { a: false, i: false, u: false, o: false };
  for (const e of events) {
    if (!isAnswerOrRelisten(e)) continue;
    const v = e.target.slice(-1);
    if (!(v in skill)) continue;
    seen[v] = true;
    if (e.ev === "r") { if (isPenalizedRelisten(e)) skill[v] = onRelisten(skill[v]); }
    else if (answeredRight(e)) skill[v] = onCorrect(skill[v]);
    else skill[v] = onWrong(skill[v]);
  }
  for (const v of ["a", "i", "u", "o"]) {
    const row = document.querySelector(`#levels [data-vowel="${v}"]`);
    if (!row) continue;
    const c = skill[v];
    // Skill is reported as the number of choice buttons shown (2..6).
    const idx = levelIdx(c);                 // -1..3
    const cap = capFor(c);                   // 2..6
    const next = LEVELS[idx + 1];            // count needed to unlock one more button
    row.querySelector(".lvl-count").textContent = seen[v] ? `streak of ${c}` : "—";
    row.querySelector(".lvl-buttons").textContent = seen[v] ? `(showing ${cap} buttons)` : "—";
    row.querySelector(".lvl-next").textContent = next != null && seen[v]
      ? `${next - c} correct answers to ${cap + 1} buttons`
      : (seen[v] ? "max" : "");
    // Meter spans the whole 0..LEVEL_MAX point scale (level boundaries drawn
    // as ticks via CSS); fill = the globally accumulated count, not just
    // progress within the current level.
    const pct = Math.max(0, Math.min(1, c / LEVEL_MAX));
    row.querySelector(".lvl-fill").style.width = (pct * 100) + "%";
  }
}

// ---------- day-bar charts (daily activity + peak streak) ----------
// Calendar-uniform days (in the viewer's local zone) from the first event up to
// *today* — not the last event — so the current day's slot and this week's/
// month's gridline show even before today's first answer (otherwise the latest
// week line is missing until you train). max() guards a future-dated event.
function calendarDays(events, valueFor) {
  const firstKey = dayKeyTz(events[0].ts, viewedTzMin);
  const lastKey = [dayKeyTz(events[events.length - 1].ts, viewedTzMin), dayKeyTz(Date.now(), viewedTzMin)].sort().pop();
  return calendarSpan(firstKey, lastKey, valueFor);
}

function renderDaily(events) {
  const map = new Map();
  for (const e of events) {
    if (!isAnswer(e)) continue;
    const k = dayKeyTz(e.ts, viewedTzMin);
    const v = map.get(k) || { correct: 0, wrong: 0 };
    if (answeredRight(e)) v.correct++; else v.wrong++;
    map.set(k, v);
  }
  const days = calendarDays(events, (k) => {
    const v = map.get(k) || { correct: 0, wrong: 0 };
    return { ...v, total: v.correct + v.wrong };
  });
  dayBarChart(dailychart, days, 200, (d) => d.total, (d, x, barW, bh, y0) => {
    const cH = d.correct / d.total * bh;
    const tip = dayTip(d.k, d.correct, d.total);
    return `<rect x="${x}%" y="${y0 - bh}%" width="${barW}%" height="${bh}%" fill="var(--bad-bar)"><title>${tip}</title></rect>`
      + `<rect x="${x}%" y="${y0 - cH}%" width="${barW}%" height="${cH}%" fill="var(--good)"><title>${tip}</title></rect>`;
  }, () => "", true);
}

// ---------- hourly ----------
// Hour-of-day in the *viewed* user's local time — UTC/JST mean nothing for their
// own daily rhythm. tzMin is their reported tz_offset (minutes east of UTC), which
// shifts each UTC timestamp onto their clock. Falls back to viewer-local only when
// the user has no tz on record (pre-tz_offset rows); on your own dashboard the two
// agree anyway.
// "UTC+9" / "UTC+5:30" / "UTC-8" / "UTC+0" from minutes east of UTC.
const tzLabel = (min) => {
  const a = Math.abs(min);
  return "UTC" + (min < 0 ? "-" : "+") + Math.floor(a / 60) + (a % 60 ? ":" + pad2(a % 60) : "");
};

function renderHourly(events) {
  hourtz.textContent = "— local time (" + (tzKnown ? tzLabel(viewedTzMin) : "tz unknown") + ")";
  const hrs = Array.from({ length: 24 }, () => ({ correct: 0, total: 0 }));
  for (const e of events) {
    if (!isAnswer(e)) continue;
    const hour = new Date(e.ts + viewedTzMin * 60000).getUTCHours();
    hrs[hour].total++;
    if (answeredRight(e)) hrs[hour].correct++;
  }
  drawHourly(hourlychart, hrs);
}


// ---------- per-mora ----------
// Fills the static .mrow elements in dashboard.html (each keyed by data-mora)
// via the shared drawBars; renderMora just tallies events into {correct, total}.
let moraCounts = null;
let moraMaxN = 1;

function renderMora(events) {
  const counts = {};
  for (const e of events) {
    if (!isAnswer(e)) continue;
    const c = counts[e.target] || (counts[e.target] = { correct: 0, total: 0 });
    c.total++;
    if (answeredRight(e)) c.correct++;
  }
  moraCounts = counts;
  moraMaxN = Math.max(1, ...Object.values(counts).map((c) => c.total));
  drawMora();
  drawConsMora();
}

function drawMora() {
  if (moraCounts) drawBars(morachart, moraCounts, moraMaxN, displayMode);
}

// The consonant-level twin of per-sound: same bars, morae summed by consonant.
function drawConsMora() {
  if (!moraCounts) return;
  const cc = consonantCounts(moraCounts);
  const maxN = Math.max(1, ...Object.values(cc).map((c) => c.total));
  drawBars(consmorachart, cc, maxN, displayMode);
}

// ---------- confusion ----------
// Walks the static td[data-t][data-p] cells across all four vowel-group tables.
// Color intensity is per-category (diag vs off-diag) so off-diagonal errors
// don't get drowned out by big correct counts.
// A pick is normalised by how often *that confuser kana was offered* — the true
// pairwise confusion the `opts` column was added to measure (so a pre-`opts`
// answer with no offered set simply doesn't appear in the matrix).
let confusionShown = null;      // T/P -> picks among opts-bearing answers (numerator)
let confusionOffered = null;    // T/P -> times kana P was on screen when T was asked (denominator)
// Alternate numerators picked by the metric switch (confMetric): guesses,
// after-plays, re-listens, slow — see confusionExtras. All but re-listen share the
// `offered` denominator; re-listen has its own (you can re-listen without answering).
let confusionGuessed = null, confusionAfterplayed = null, confusionRelistened = null, confusionRelistenedOffered = null, confusionSlow = null;
// Which numerator the matrix shows: wrong (picks) | guessed | relistened | afterplayed.
// Rings/cell-history/drift always use the picks (confusionShown), regardless.
let confMetric = wireSwitchGroup(document.querySelectorAll('[data-switch="metric"]'), (m) => {
  confMetric = m;
  drawConfusion();   // redraws the vowel + consonant matrices with the new numerator
});
const confNumerator = () => ({
  wrong: confusionShown, guessed: confusionGuessed, relistened: confusionRelistened,
  afterplayed: confusionAfterplayed, slow: confusionSlow,
}[confMetric] || confusionShown);
// Re-listen counts against every question that offered the kana (answered or not),
// so it uses its own denominator; the others normalise by answered offers.
const confDenominator = () => confMetric === "relistened" ? confusionRelistenedOffered : confusionOffered;

// Confusion-bearing answers (multi-choice + the synthesised Y/N picks), kept
// chronological for the click-to-inspect cell history. Each carries the
// normalised `picked`/`opts` from confusionRecord, so the strip reads Y/N the
// same way the matrix counts it.
let confusionEvents = [];

// The currently-shown cell's series (one entry per ○/✕ mark, oldest→newest), so
// the strip's click handler can map a tapped mark back to its answer event.
let cellSeries = [];
let cellDiag = false;   // is the shown cell on the diagonal — there a ✕ is a wrong pick, so the tapped mark surfaces which kana was chosen

function renderConfusion(events) {
  // The matrix is one projection (confusionMaps) of one tally (tallyFromEvents) —
  // the exact tally the app builds live and the drift check compares against, so
  // the displayed matrix and the grind tally can't disagree. (Hand-rolling the
  // shown/offered maps here is what let them drift, flagging "out of sync"
  // forever.) The per-event loop below is only for the cell-history strip, which
  // needs each answer's timestamp/pick — detail a tally aggregates away.
  const { shown, offered } = confusionMaps(tallyFromEvents(events));
  confusionEvents = [];
  for (const e of events) {
    // confusionRecord normalises multi-choice (a/g) and Y/N (y/n) into the same
    // { target, picked, opts } shape — see shared/tally.js. A Y/N diagonal-miss
    // (heard the right kana, said "no") has picked "" with no confuser; it's still
    // a ✕ on the diagonal cell (opts includes the target), so keep the event even
    // though it adds nothing to shown. Answers with no offered set yield no record.
    const r = confusionRecord(e);
    if (r) confusionEvents.push({ ...e, picked: r.picked, opts: r.opts.join(",") });
  }
  confusionEvents.sort((a, b) => a.ts - b.ts);
  confusionShown = shown;
  confusionOffered = offered;
  ({ guessed: confusionGuessed, afterPlayed: confusionAfterplayed, reListened: confusionRelistened, reListenedOffered: confusionRelistenedOffered, slow: confusionSlow } = confusionExtras(events));
  drawConfusion();
}

function drawConfusion() {
  if (!confusionShown) return;
  const maps = { shown: confNumerator(), offered: confDenominator() };
  const cells = confchart.querySelectorAll("td[data-t]");
  fillConfusionCells(cells, maps, displayMode);

  // Grind/probe rings are a property of the pick-when-offered data, not the
  // display mode, so they're marked in every mode (see shared/confusion.js). The
  // dashboard rings every uncertain case (probes), not just the next-to-drill one.
  const { grind, probes } = confusionTargets(confusionShown, confusionOffered);
  for (const td of cells) {
    const key = `${td.dataset.t}/${td.dataset.p}`;
    td.classList.toggle("grind", grind.has(key));
    td.classList.toggle("probe", probes.has(key));
  }
  drawConsonantConfusion();
}

// The consonant matrix collapses every vowel and shows confusion between the six
// consonant classes (s z ts sh j ch). Same data and display mode as the per-vowel
// matrix above, just aggregated by consonant. Non-clickable.
function drawConsonantConfusion() {
  if (!confusionShown) return;
  const maps = aggregateByConsonant({ shown: confNumerator(), offered: confDenominator() });
  fillConfusionCells(conschart.querySelectorAll("td[data-t]"), maps, displayMode);
}

// ---------- per-recording (sound-file) confusion ----------
// The viewer's own version of the admin matrix: which recordings they confuse
// with which kana. Computed from the same opts-bearing a/g answers as the main
// matrix, but keyed by the question's recording (e.voice) too — matching the
// server's by_voice_shown/offered. Y/N answers carry no recording, so excluded.
let voiceShownRows = [], voiceOfferedRows = [];

function renderVoiceConfusion(events) {
  const shown = {}, offered = {};
  for (const e of events) {
    if ((e.ev !== "a" && e.ev !== "g") || !e.voice) continue;
    const r = confusionRecord(e);
    if (!r) continue;   // no offered set
    shown[`${r.target}/${e.voice}/${r.picked}`] = (shown[`${r.target}/${e.voice}/${r.picked}`] || 0) + 1;
    for (const k of r.opts) offered[`${r.target}/${e.voice}/${k}`] = (offered[`${r.target}/${e.voice}/${k}`] || 0) + 1;
  }
  const rows = (m, key) => Object.entries(m).map(([s, n]) => {
    const [t, v, x] = s.split("/");
    return { t, v, [key]: x, n };
  });
  voiceShownRows = rows(shown, "p");
  voiceOfferedRows = rows(offered, "k");
  vcmin.oninput = drawVoiceConf;
  vcwrong.oninput = drawVoiceConf;
  drawVoiceConf();
}

function drawVoiceConf() {
  renderVoiceConf(voiceconf, voiceShownRows, voiceOfferedRows, {
    mode: displayMode,
    minA: Math.max(0, parseInt(vcmin.value, 10) || 0),
    minW: Math.max(0, parseInt(vcwrong.value, 10) || 0),
  });
}

// Click a recording's row header to play it (delegated; survives re-renders).
voiceconf.addEventListener("click", (e) => {
  const th = e.target.closest("th.vname");
  if (th) playVoice(th.dataset.mora, th.dataset.voice);
});

// ---------- confusion cell history ----------
// Click a matrix cell to inspect that sound→kana pair over time as a ○/✕ strip
// (✕ = bad, teal/orange-tinted) with a logistic trend line. The bad outcome is:
// off-diagonal → the user picked the column kana (the confusion happened);
// diagonal → the user got it wrong. Only opts-bearing answers where the column
// kana was actually offered count (same data as the shown/grind metrics).
function showCellHistory(td) {
  confhint.hidden = true;                 // tapped a cell — the discovery hint's done its job (this session; it returns on reload)
  const t = td.dataset.t, p = td.dataset.p, diag = t === p;
  cellDiag = diag;
  const series = confusionEvents.filter((e) => e.target === t && e.opts.split(",").includes(p));
  const outcomes = series.map((e) => ((diag ? e.picked !== t : e.picked === p) ? 1 : 0)); // 1 = red/bad

  // Pair label from the headers: row th = katakana sound, col th = hiragana kana.
  const table = td.closest("table");
  const rowGlyph = td.parentElement.querySelector("th").textContent;
  const colGlyph = table.querySelector("thead tr").children[td.cellIndex].textContent;

  for (const c of confchart.querySelectorAll("td.selected")) c.classList.remove("selected");
  td.classList.add("selected");

  const pair = diag ? rowGlyph : `${rowGlyph} → ${colGlyph}`;
  // Mark geometry — also used to reserve the strip's height when there are no
  // marks yet, so the detail box doesn't change height between cells.
  const S = 22, GAP = 4, CW = S + GAP, BH = S + GAP, R = 6;
  if (outcomes.length === 0) {
    cellSeries = [];
    confdetail.innerHTML =
      `<div class="cd-head">${pair} — no answers with ${colGlyph} offered yet</div>` +
      `<svg class="cd-strip" width="0" height="${BH}" aria-hidden="true"></svg>`;
    confdetail.hidden = false;
    return;
  }

  // One まる・ばつ mark per answer, oldest→newest; the strip scrolls if there are
  // many. Shape (○ good / ✕ bad) carries the outcome so it reads without colour
  // (red-green colourblind support); the teal/orange fill reinforces. The
  // optional trend line plots P(bad) from the top, so it rises as the cell improves.
  const n = outcomes.length;
  const bad = outcomes.reduce((s, o) => s + o, 0);
  const W = n * CW;
  // Each mark is a colour-coded box (good/bad fill — the at-a-glance cue) with a
  // ○/✕ symbol stroked on top in the page background colour, so the outcome reads
  // by shape too (red-green colourblind support). The whole box is a generous tap
  // target wrapped in a clickable <g> carrying its series index, so tapping it
  // replays that question's recording — see the confdetail click handler.
  // cellSeries lets the handler map index → event.
  cellSeries = series;
  const marks = outcomes.map((o, i) => {
    const cx = i * CW + CW / 2, cy = BH / 2, fill = `var(--${o ? "bad" : "good"})`;
    const sym = o
      ? `<path d="M${cx - R} ${cy - R}l${2 * R} ${2 * R}M${cx + R} ${cy - R}l${-2 * R} ${2 * R}" stroke="var(--bg)" stroke-width="2.2" fill="none"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${R}" stroke="var(--bg)" stroke-width="2.2" fill="none"/>`;
    return `<g class="cd-mark" data-i="${i}"><rect x="${i * CW + GAP / 2}" y="${GAP / 2}" width="${S}" height="${S}" rx="5" fill="${fill}"/>${sym}</g>`;
  }).join("");

  // Draw a trend line / call a direction only when the trend is statistically
  // real (likelihood-ratio test) — never off a few noisy points. Otherwise: a
  // clearly one-sided cell (e.g. 0/8) is "consistent", not random; only a genuinely
  // mixed one is "no clear trend".
  const tr = logisticTrend(outcomes);
  const rate = bad / n;
  let curve = "", trend;
  if (tr.significant) {
    const pts = [];
    for (let s = 0; s <= 24; s++) {
      const x = s / 24;
      const xpx = x * (n - 1) * CW + CW / 2;
      pts.push(`${xpx.toFixed(1)},${(logisticAt(tr.fit, x) * BH).toFixed(1)}`);
    }
    curve = `<polyline points="${pts.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2" pointer-events="none"/>`;
    trend = tr.improving ? "improving ↑" : "worsening ↓";
  } else if (n >= 5 && (rate <= 0.2 || rate >= 0.8)) {
    trend = "consistent";
  } else {
    trend = "no clear trend";
  }

  const label = diag ? `${bad}/${n} wrong` : `confused ${bad}/${n}`;
  // The replay hint rides on the head row as a muted parenthetical; tapping a
  // mark swaps it for that recording's name (see the confdetail click handler).
  confdetail.innerHTML =
    `<div class="cd-head">${pair} · ${label} · ${trend} <span class="cd-file" aria-live="polite">(tap a ○ / ✕ to replay that question's recording)</span></div>` +
    `<svg class="cd-strip" width="${W}" height="${BH}" role="img" aria-label="${pair} history">${marks}${curve}</svg>`;
  confdetail.hidden = false;
}

// Click a ○/✕ mark to replay the exact recording that played for that question
// and surface its filename above the strip. (target vowel, target mora, idx) pin
// the file: audio/<vowel>/<mora>/<idx>.opus, the same layout the app and admin
// play from (one level up, since the dashboard lives under /dashboard/). `voice`
// is the recording's source name; older pre-`voice` events just show the path.
const cellPlayer = new Audio();
confdetail.addEventListener("click", (e) => {
  const g = e.target.closest(".cd-mark");
  if (!g) return;
  const ev = cellSeries[+g.dataset.i];
  if (!ev) return;
  const file = `audio/${ev.target.slice(-1)}/${ev.target}/${ev.idx}.opus`;
  cellPlayer.src = "../" + file;
  cellPlayer.currentTime = 0;
  cellPlayer.play().catch(() => { });
  for (const m of confdetail.querySelectorAll(".cd-mark.playing")) m.classList.remove("playing");
  g.classList.add("playing");
  cellPlayer.onended = () => { g.classList.remove("playing"); cellPlayer.onended = null; };
  const fileEl = confdetail.querySelector(".cd-file");
  if (fileEl) {
    // On the diagonal a ✕ is a wrong answer, so name the kana the user actually
    // picked (off the diagonal that's just the column, already in the header). The
    // recording that played is the cell's own sound, kept for replay identity.
    const picked = cellDiag && ev.picked && ev.picked !== ev.target ? HIRAGANA[ev.picked] : null;
    fileEl.textContent = picked ? `(picked ${picked} · ${ev.voice || file})` : `(${ev.voice || file})`;
  }
});

confchart.addEventListener("click", (e) => {
  const td = e.target.closest("td[data-t]");
  if (td) showCellHistory(td);
});

// ---------- local drill-tally drift ----------
// The app keeps a localStorage `grind_tally` (built from your answers) that the
// day-start probe reads; it never re-syncs with the server, so after local DB
// resets it can drift from what the server's events say. Detect that and offer a
// one-click resync that rebuilds the tally from these events. Only when viewing
// your OWN uid — the tally is the viewer's, so comparing it to someone else's
// events would be meaningless. Drift = the stored tally and the events-rebuilt
// tally project to different confusion maps; both go through tally.js's tallyMaps
// — the same projection the matrix renders (confusionMaps) and the app builds —
// so a settled sync stays settled.

const sameMap = (a, b) => {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
};

let pendingSync = null;   // tally rebuilt from the DB, written on Sync

function checkTallyDrift(events) {
  if (uid !== viewerUid) { syncnotice.hidden = true; pendingSync = null; return; }  // own data only
  let stored = {};
  try { stored = JSON.parse(localStorage.grind_tally) || {}; } catch { }
  const server = tallyFromEvents(events);
  const a = tallyMaps(stored), b = tallyMaps(server);
  const drift = !sameMap(a.shown, b.shown) || !sameMap(a.offered, b.offered);
  pendingSync = drift ? server : null;
  syncnotice.hidden = !drift;
}

syncbtn.onclick = () => {
  if (!pendingSync) return;
  localStorage.grind_tally = JSON.stringify(pendingSync);
  pendingSync = null;
  syncnotice.textContent = "Synced — reload the app for the probe to use the updated data.";
};

// ---------- streak ----------
// Per-day *peak* streak as a bar chart with a calendar-uniform x-axis. The
// previous "polyline of every event's run" version made a misleading
// diagonal across days with no activity. Daily peaks read cleanly and align
// with the daily-activity chart's x-axis.
function renderStreak(events) {
  const peaks = dailyPeakStreaks(events);
  if (peaks.size === 0) { streakchart.textContent = "(no answers)"; return; }
  const days = calendarDays(events, (k) => ({ run: peaks.get(k) || 0 }));
  dayBarChart(streakchart, days, 160, (d) => d.run,
    (d, x, barW, bh, y0) =>
      `<rect x="${x}%" y="${y0 - bh}%" width="${barW}%" height="${bh}%" fill="var(--accent)"><title>${d.k}  peak streak ${d.run}</title></rect>`,
    (max, X, Y) => `<text x="${X(940)}%" y="${Y(14)}%" fill="var(--muted)" font-size="11" text-anchor="end">peak: ${max}</text>`, true);
}

// ---------- reaction time ----------
function renderRtime(events) {
  const ag = events.filter(
    (e) => isAnswer(e) && e.ms != null && e.ms >= 0 && e.ms < 20000
  );
  if (ag.length === 0) { rtchart.textContent = "(no timed answers)"; return; }
  const cap = 6000;
  const buckets = 30;
  const cb = new Array(buckets).fill(0);
  const wb = new Array(buckets).fill(0);
  for (const e of ag) {
    const b = Math.min(buckets - 1, Math.floor(e.ms / (cap / buckets)));
    if (answeredRight(e)) cb[b]++; else wb[b]++;
  }
  const mx = Math.max(1, ...cb, ...wb);
  // Logical 900×200 box emitted as percentages (no viewBox) — see renderHourly.
  const w = 900, h = 200;
  const innerH = h - 40;
  const bw = (w - 40) / buckets;
  const X = (v) => (v / w * 100).toFixed(2), Y = (v) => (v / h * 100).toFixed(2);
  let bars = "";
  for (let i = 0; i < buckets; i++) {
    const x = 20 + i * bw;
    const ch = cb[i] / mx * innerH;
    const wh = wb[i] / mx * innerH;
    const lo = Math.round(i * cap / buckets);
    const hi = Math.round((i + 1) * cap / buckets);
    bars += `<rect x="${X(x)}%" y="${Y(h - 20 - ch)}%" width="${X(bw * 0.45)}%" height="${Y(ch)}%" fill="var(--good)"><title>${lo}-${hi}ms: ${cb[i]} correct</title></rect>`;
    bars += `<rect x="${X(x + bw * 0.5)}%" y="${Y(h - 20 - wh)}%" width="${X(bw * 0.45)}%" height="${Y(wh)}%" fill="var(--bad-bar)"><title>${lo}-${hi}ms: ${wb[i]} wrong</title></rect>`;
  }
  let axis = "";
  for (let t = 0; t <= cap; t += 1000) {
    const x = 20 + (t / cap) * (w - 40);
    axis += `<text x="${X(x)}%" y="${Y(h - 4)}%" fill="var(--muted)" font-size="10" text-anchor="middle">${t / 1000}s</text>`;
  }
  rtchart.innerHTML = `<svg>${bars}${axis}</svg>`;
}

// ---------- helpers ----------
// (niceTicks + dayBarChart now in src/shared/daychart.js)
