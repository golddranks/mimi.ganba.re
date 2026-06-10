import { aggregateByConsonant, consonantCounts, fillConfusionCells } from "../shared/confusion.js";
import { drawBars, drawHourly, wireSwitchGroup } from "../shared/charts.js";
import { playVoice, drawVoiceConfusion as renderVoiceConf } from "../shared/voiceconf.js";

// Level-1 power-user dashboard: app-wide aggregate stats with no device
// identifiers. Fetches one endpoint into the static skeleton in stats/index.html:
//   /v1/admin/stats   (power_user >= 1) — hourly, per-sound, confusion matrices
// The per-user / uid-drilldown sections (overview, histograms, daily) live on the
// level-2 /admin/ page, which reads /v1/admin/stats/users instead.

// When served from localhost (via scripts/dev.sh) hit the local wrangler dev
// worker so the panel reflects local-DB events rather than production.
const STATS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? `http://${location.hostname}:8787`
  : "https://mimi-stats.golddranks.workers.dev";

// Display mode shared across the three count/per-sound-% toggles (per-sound,
// confusion matrix, sound-file confusion). Clicking any of them updates
// every switch and re-renders all three sections.
let displayMode = "count";
// Confusion population: "0" normal users, "2" native testers. A two-button switch
// (like the count/% one), mirrored in the sound-file matrix's filter row. Starts
// at "0" to match the page's default fetch — so a refresh resets cleanly.
let confpopRole = "0";

// uid resolution mirrors the no-uid head script so first paint matches behaviour.
// Pulled from localStorage by default (set by the main app); ?uid=… overrides
// for cases like a fresh browser or testing as a different power user.
const uid = new URLSearchParams(location.search).get("uid") || localStorage.getItem("uid") || "";

// The confusion query string: min-accuracy (number input) + the population
// toggle. Used by the initial load and every re-filter, so the first paint
// matches the controls — which the browser persists across a soft reload (and
// clears on a hard reload), exactly like the number-input filters.
const confusionParams = () =>
  "&minacc=" + Math.max(0, Math.min(100, parseInt(confminacc.value, 10) || 0))
  + "&pop=" + confpopRole;   // 0 normal · 2 natives · all (normal+native) · me (just this viewer)

// Seed the count/% and normal/natives toggles from their restored-or-default
// state and wire user changes — before the first load(), so its fetch + render
// reflect the controls. (onPick fires only on a user change, by when data has
// loaded; the returned value is the current selection.)
displayMode = wireSwitchGroup(document.querySelectorAll('[data-switch="mode"]'), (m) => {
  displayMode = m;
  drawMora();
  drawConsMora();
  drawConfusion();
  drawVoiceConfusion();
});
confpopRole = wireSwitchGroup(document.querySelectorAll('[data-switch="pop"]'), (p) => {
  confpopRole = p;
  reloadConfusion();
});

// No uid (e.g. a private window that never opened the app) can't be authorized,
// so skip the fetch and say so directly — otherwise load() never runs and the
// page would fall back to the bare CSS "Unauthorized." pseudo-element.
if (uid) load(uid);
else showUnauthorized("stats");

async function load(uid) {
  try {
    const res = await fetch(STATS_URL + "/v1/admin/stats?uid=" + encodeURIComponent(uid) + confusionParams());
    if (res.status === 403) {
      showUnauthorized("stats");
      return;
    }
    if (!res.ok) { msg.textContent = `Fetch failed: HTTP ${res.status}`; return; }
    const data = await res.json();
    renderOverview(data);
    renderHourly(data.hourly);
    renderMora(data.by_mora);
    renderVoiceConfusion(data);
    renderConfusion(data);
  } catch (e) {
    msg.textContent = "Error: " + (e && e.message);
  }
}

// Hide the dashboard skeleton and explain why. Two cases: a uid that the worker
// rejected (403) names the device ID — a text node, so it can't inject HTML;
// no uid at all (private window, never opened the app) has none to report. Both
// point at the personal dashboard. `page` names the panel hit — this page and
// /admin/ share the wording bar that one word.
function showUnauthorized(page) {
  dash.style.display = "none";
  const dashboard = Object.assign(document.createElement("a"), {
    href: "https://mimi.ganba.re/dashboard/",
    textContent: "Dashboard",
  });
  if (uid) {
    msg.replaceChildren(
      `Your Device ID (${uid}) is unauthorized to view the ${page} page. `,
      "Ask the administrator for the rights, or use the personal ",
      dashboard, " instead.",
    );
  } else {
    msg.replaceChildren(
      `This device has no Device ID, so it can't view the ${page} page. Use the personal `,
      dashboard, " instead.",
    );
  }
}

// Re-fetch just the confusion matrices (the only sections min-accuracy and the
// population toggle gate server-side) and re-render them. Debounced for minacc so
// typing in the number field doesn't fire a request per keystroke.
async function reloadConfusion() {
  try {
    const res = await fetch(STATS_URL + "/v1/admin/stats?uid=" + encodeURIComponent(uid) + confusionParams());
    if (!res.ok) return;
    const data = await res.json();
    renderConfusion(data);
    renderVoiceConfusion(data);
  } catch { /* leave the current matrices in place */ }
}
// Two synced copies of the control: one inline in the confusion h2, one in the
// sound-file matrix's filter row (the filter gates both matrices). Editing either
// mirrors the value to the other and debounce-reloads.
let accTimer = null;
const onMinacc = (src) => {
  confminacc.value = confminacc2.value = src.value;
  clearTimeout(accTimer);
  accTimer = setTimeout(reloadConfusion, 400);
};
confminacc.oninput = () => onMinacc(confminacc);
confminacc2.oninput = () => onMinacc(confminacc2);

// Click-to-play delegation on the sound-file confusion matrix (its row headers
// play the recording). Bound on the stable parent so it survives each redraw
// (which replaces only the inner HTML).
voiceconf.addEventListener("click", (e) => {
  const th = e.target.closest("th.vname");
  if (!th) return;
  playVoice(th.dataset.mora, th.dataset.voice);
});

// ---------- overview ----------
// App-wide aggregate counters (no device identifiers) — the level-1 endpoint
// carries them. "days of data" is t.days (distinct answer-days); this tier
// doesn't fetch the per-day series the /admin/ daily chart uses.
const setStat = (k, v) => overview.querySelector(`[data-stat="${k}"]`).textContent = v;

function renderOverview(data) {
  const t = data.totals || {};
  const a = data.active || {};
  const answers = t.answers || 0;
  const acc = answers ? (t.correct || 0) / answers : 0;
  setStat("events", t.events || 0);
  setStat("users", t.users || 0);
  setStat("answers", answers);
  setStat("accuracy", (acc * 100).toFixed(1) + "%");
  setStat("relisten", t.relisten || 0);
  setStat("active7", a.d7 || 0);
  setStat("active30", a.d30 || 0);
  setStat("days", t.days || 0);
}

// ---------- hourly (UTC) ----------
function renderHourly(hourly) {
  const hrs = Array.from({ length: 24 }, () => ({ correct: 0, total: 0 }));
  for (const r of hourly || []) hrs[r.h] = { correct: r.correct, total: r.n };
  drawHourly(hourlychart, hrs, " UTC");
}

// ---------- per-sound difficulty ----------
// Fills the static .mrow elements (keyed by data-mora) via the shared drawBars,
// which orders them hardest-first; renderMora just normalises the server's
// {m, n, correct} rows into {correct, total}.
let moraCounts = null;
let moraMaxN = 1;

function renderMora(byMora) {
  const counts = {};
  for (const r of byMora || []) counts[r.m] = { correct: r.correct, total: r.n };
  moraCounts = counts;
  moraMaxN = Math.max(1, ...Object.values(counts).map((c) => c.total || 0));
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

// ---------- confusion (same metric switch as the user dashboard; counts are
// server-aggregated rather than computed from a local event stream) ----------
// Each server row is { t, <p|k>, n }; fold into a t/<x> -> n map. The metric switch
// (confMetric) picks which numerator + denominator + colour scheme to show, exactly
// like the dashboard — see src/dashboard/dashboard.js and src/shared/tally.js.
const mapOf = (rows, key) => { const m = {}; for (const r of rows || []) m[`${r.t}/${r[key]}`] = r.n; return m; };
const mapOf3 = (rows, key) => { const m = {}; for (const r of rows || []) m[`${r.t}/${r.v}/${r[key]}`] = r.n; return m; };

let confusionShown = null, confusionOffered = null, confusionGuessed = null,
    confusionAfterplayed = null, confusionRelistened = null, confusionRelistenedOffered = null, confusionSlow = null;

// The metric switch (one in the confusion h2, a synced copy in the sound-file h2)
// is a pure re-render — all metrics ride in the one response, so no refetch.
let confMetric = wireSwitchGroup(document.querySelectorAll('[data-switch="metric"]'), (m) => {
  confMetric = m;
  drawConfusion();
  drawVoiceConfusion();
});
const confNumerator = () => ({
  answered: confusionShown, guessed: confusionGuessed, relistened: confusionRelistened,
  afterplayed: confusionAfterplayed, slow: confusionSlow,
}[confMetric] || confusionShown);
// Re-listen normalises by all questions that offered the kana (its own denominator);
// the others by answered offers. Re-listen / after-play drop the right/wrong colours.
const confDenominator = () => confMetric === "relistened" ? confusionRelistenedOffered : confusionOffered;
const confScheme = () => (confMetric === "relistened" || confMetric === "afterplayed") ? "neutral" : "outcome";

function renderConfusion(data) {
  confusionShown = mapOf(data.confusion_shown, "p");
  confusionOffered = mapOf(data.confusion_offered, "k");
  confusionGuessed = mapOf(data.confusion_guessed, "p");
  confusionAfterplayed = mapOf(data.confusion_afterplayed, "p");
  confusionRelistened = mapOf(data.confusion_relistened, "k");
  confusionRelistenedOffered = mapOf(data.confusion_relistened_offered, "k");
  confusionSlow = mapOf(data.confusion_slow, "p");
  drawConfusion();
}

function drawConfusion() {
  if (!confusionShown) return;
  const maps = { shown: confNumerator(), offered: confDenominator() };
  fillConfusionCells(confchart.querySelectorAll("td[data-t]"), maps, displayMode, confScheme());
  drawConsonantConfusion();
}

// Consonant matrix: collapses every vowel into confusion between the six
// consonant classes (s z ts sh j ch). Same metric/mode as the per-vowel matrix.
function drawConsonantConfusion() {
  if (!confusionShown) return;
  const maps = aggregateByConsonant({ shown: confNumerator(), offered: confDenominator() });
  fillConfusionCells(conschart.querySelectorAll("td[data-t]"), maps, displayMode, confScheme());
}

// ---------- sound-file confusion matrix (per recording) ----------
// Same metric switch drives it; the server precomputes every metric per recording.
let voiceMetricMaps = null;

function renderVoiceConfusion(data) {
  voiceMetricMaps = {
    answered: mapOf3(data.by_voice_shown, "p"),
    offered: mapOf3(data.by_voice_offered, "k"),
    guessed: mapOf3(data.by_voice_guessed, "p"),
    afterplayed: mapOf3(data.by_voice_afterplayed, "p"),
    relistened: mapOf3(data.by_voice_relistened, "k"),
    relistenedOffered: mapOf3(data.by_voice_relistened_offered, "k"),
    slow: mapOf3(data.by_voice_slow, "p"),
  };
  vcmin.oninput = drawVoiceConfusion;
  vcwrong.oninput = drawVoiceConfusion;
  drawVoiceConfusion();
}

function drawVoiceConfusion() {
  if (!voiceMetricMaps) return;
  const num = voiceMetricMaps[confMetric] || voiceMetricMaps.answered;
  const den = confMetric === "relistened" ? voiceMetricMaps.relistenedOffered : voiceMetricMaps.offered;
  const rows = (m, key) => Object.entries(m).map(([s, n]) => {
    const [t, v, x] = s.split("/");
    return { t, v, [key]: x, n };
  });
  // Only "answered" has a wrong axis (off-diagonal); the rest count the diagonal too.
  const answered = confMetric === "answered";
  vcwronglabel.textContent = answered ? "min % wrong" : "min %";
  renderVoiceConf(voiceconf, rows(num, "p"), rows(den, "k"), {
    mode: displayMode,
    minA: Math.max(0, parseInt(vcmin.value, 10) || 0),
    minW: Math.max(0, parseInt(vcwrong.value, 10) || 0),
    scheme: confScheme(),
    diagIsSignal: !answered,
  });
}
