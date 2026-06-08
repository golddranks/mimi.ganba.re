import { aggregateByConsonant, consonantCounts, fillConfusionCells } from "../shared/confusion.js";
import { dayBarChart, dayTip, calendarSpan } from "../shared/daychart.js";
import { drawBars, drawHourly, wireSwitchGroup } from "../shared/charts.js";
import { playVoice, drawVoiceConfusion as renderVoiceConf } from "../shared/voiceconf.js";

// Power-user-only app-wide aggregate dashboard. Fans two endpoints into the
// static skeleton declared in admin/index.html. Auth is the requester's own
// uid (URL ?uid= or localStorage.uid); the worker checks users.power_user.
//   /v1/admin/stats        (power_user >= 1) — sound / aggregate sections only
//   /v1/admin/stats/users  (power_user >= 2) — overview, per-user histograms,
//                                              daily activity, uid drilldowns
// A level-1 user gets the aggregate sections; the .l2only sections stay hidden
// because the second fetch 403s for them.

// When served from localhost (via scripts/dev.sh) hit the local wrangler dev
// worker so the admin panel reflects local-DB events rather than production.
const STATS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? `http://${location.hostname}:8787`
  : "https://mimi-stats.golddranks.workers.dev";

// uid → nickname and uid → tz offset (minutes east of UTC, from push_subs),
// populated on load. Used by showUidPopup to annotate the drill-down list.
// Empty until the first /v1/admin/stats/users response.
let nicknames = {};
let timezones = {};

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
  + (confpopRole === "2" ? "&natives=1" : "");

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

if (uid) load(uid);

async function load(uid) {
  try {
    const res = await fetch(STATS_URL + "/v1/admin/stats?uid=" + encodeURIComponent(uid) + confusionParams());
    if (res.status === 403) {
      msg.textContent = "Unauthorized.";
      dash.style.display = "none";
      return;
    }
    if (!res.ok) { msg.textContent = `Fetch failed: HTTP ${res.status}`; return; }
    const data = await res.json();
    // Aggregate sections — available to every power user (level 1+).
    renderHourly(data.hourly);
    renderMora(data.by_mora);
    renderVoiceConfusion(data.by_voice_shown, data.by_voice_offered);
    renderConfusion(data.confusion_shown, data.confusion_offered);
    // Per-user / uid-drilldown sections — only if level-2 authorizes them.
    loadUserStats(uid);
  } catch (e) {
    msg.textContent = "Error: " + (e && e.message);
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
    renderConfusion(data.confusion_shown, data.confusion_offered);
    renderVoiceConfusion(data.by_voice_shown, data.by_voice_offered);
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

// Second-tier fetch. 403 (level-1 user) or any failure silently leaves the
// .l2only sections hidden — the page still shows the aggregate sections.
async function loadUserStats(uid) {
  try {
    const res = await fetch(STATS_URL + "/v1/admin/stats/users?uid=" + encodeURIComponent(uid));
    if (!res.ok) return;
    const data = await res.json();
    nicknames = data.nicknames || {};
    timezones = data.timezones || {};
    renderOverview(data);
    renderLevelHist(data.level_hist, data.level_hist_uids);
    renderDaysHist(data.days_hist, data.days_hist_uids);
    renderActivityHist(data.activity_hist, data.activity_hist_uids);
    renderDaily(data.daily, data.daily_uids);
    for (const s of document.querySelectorAll(".l2only")) s.hidden = false;
  } catch (e) { /* keep the l2only sections hidden */ }
}

// ---------- overview ----------
const setStat = (k, v) => overview.querySelector(`[data-stat="${k}"]`).textContent = v;

function renderOverview(data) {
  const t = data.totals || {};
  const a = data.active || {};
  const correct = t.correct || 0;
  const answers = t.answers || 0;
  const acc = answers ? correct / answers : 0;
  setStat("events", t.events || 0);
  setStat("users", t.users || 0);
  setStat("answers", answers);
  setStat("accuracy", (acc * 100).toFixed(1) + "%");
  setStat("relisten", t.relisten || 0);
  setStat("active7", a.d7 || 0);
  setStat("active30", a.d30 || 0);
  setStat("days", (data.daily || []).length);
}

// ---------- daily ----------
// Bars carry data-date so clicking either the bad (wrong) or good (correct)
// stack reveals the contributing uids — same pattern as the histograms.
function renderDaily(daily, uids) {
  if (!daily || daily.length === 0) { dailychart.textContent = "(no data)"; return; }
  // Calendar-uniform across the server's day range (it already reaches "today"
  // via cross-user activity, so — unlike the per-user dashboard — there's no
  // missing-current-week issue to extend past it).
  const map = new Map(daily.map((r) => [r.d, r]));
  const days = calendarSpan(daily[0].d, daily[daily.length - 1].d, (k) => {
    const r = map.get(k) || { n: 0, correct: 0 };
    return { n: r.n, correct: r.correct };
  });
  // A full-height transparent band over each column (laid on top of the thin
  // bars) carries data-date, so clicking anywhere in the column reveals that
  // day's uids — and a CSS hover darkens the whole column as a click cue.
  dayBarChart(dailychart, days, 200, (d) => d.n, (d, x, barW, bh, y0, bandX, bandW) => {
    const cH = d.n ? d.correct / d.n * bh : 0;
    const tip = dayTip(d.k, d.correct, d.n);
    return `<rect x="${x}%" y="${y0 - bh}%" width="${barW}%" height="${bh}%" fill="var(--bad-bar)"></rect>`
      + `<rect x="${x}%" y="${y0 - cH}%" width="${barW}%" height="${cH}%" fill="var(--good)"></rect>`
      + `<rect class="dayband" data-date="${d.k}" x="${bandX}%" y="0" width="${bandW}%" height="${y0}%"><title>${tip}</title></rect>`;
  }, () => "", true);
  dailychart.onclick = (e) => {
    const r = e.target.closest("rect[data-date]");
    if (!r) return;
    showUidPopup(r.dataset.date, (uids || {})[r.dataset.date] || []);
  };
}

// ---------- user-level histograms per vowel ----------
// Bins 0..4 correspond to caps 2..6 (= number of choice buttons shown for
// questions at that level; see LEVELS = [10,15,20,25] in app.js). The
// static skeleton for the 4 charts lives in admin/index.html; this only
// updates bar heights, count labels, and tooltips, so the layout is fixed
// from first paint and the section doesn't flash blank.
function renderLevelHist(hist, uids) {
  const data = hist || { a: [0, 0, 0, 0, 0], i: [0, 0, 0, 0, 0], u: [0, 0, 0, 0, 0], o: [0, 0, 0, 0, 0] };
  const baseY = 118, innerH = 104; // must match the static SVG geometry
  const VOWEL_GYO = { a: "あ行", i: "い行", u: "う行", o: "お行" };
  for (const v of ["a", "i", "u", "o"]) {
    const bins = data[v] || [0, 0, 0, 0, 0];
    const bucketUids = (uids && uids[v]) || [[], [], [], [], []];
    const total = bins.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...bins);
    const col = levelhist.querySelector(`.lvlcol[data-vowel="${v}"]`);
    col.querySelector(".lvltotal").textContent = total;
    for (let i = 0; i < 5; i++) {
      const bh = bins[i] / max * innerH;
      const rect = col.querySelector(`rect[data-bin="${i}"]`);
      rect.setAttribute("height", bh);
      rect.setAttribute("y", baseY - bh);
      rect.querySelector("title").textContent = `${i + 2} buttons: ${bins[i]} users`;
      const text = col.querySelector(`text.bincount[data-bin="${i}"]`);
      text.setAttribute("y", baseY - bh - 2);
      text.textContent = bins[i] || "";
      rect.onclick = () => showUidPopup(`${VOWEL_GYO[v]} · ${i + 2} buttons`, bucketUids[i]);
    }
  }
}

// ---------- distribution histograms (activity / days) ----------
// Generic painter for an N-bin histogram. The outer `<svg>` lives statically in
// admin/index.html so the section reserves its layout; this fills in the bars +
// axis labels on data load. Geometry is computed in a logical `w`×`h` box but
// emitted as percentages (no viewBox) so the SVG stretches to fill its
// container with crisp px text (`w` still sets the bar/padding proportions).
// `labels[i]` is shown under bar i (use "" to suppress for crowded x-axes).
// `tooltipFn(i, n)` builds the SVG <title> (hover text incl. count).
// If `uids` + `titleFn(i)` are provided, every bar gets a click handler
// that pops up the contributing device IDs as links to the per-user
// dashboard. `titleFn` returns the bucket name *without* a count — the
// popup appends it.
function paintHist(svgEl, w, h, bins, labels, tooltipFn, uids, titleFn) {
  const padL = 14, padR = 14;
  const baseY = h - 22, innerH = baseY - 14;
  const n = bins.length;
  const bw = (w - padL - padR) / n;
  const barW = Math.max(2, bw * 0.78);
  const max = Math.max(1, ...bins);
  const X = (v) => (v / w * 100).toFixed(2), Y = (v) => (v / h * 100).toFixed(2);
  let html = "";
  for (let i = 0; i < n; i++) {
    const cx = padL + (i + 0.5) * bw;
    const bh = bins[i] / max * innerH;
    html += `<rect data-bin="${i}" x="${X(cx - barW / 2)}%" y="${Y(baseY - bh)}%" width="${X(barW)}%" height="${Y(bh)}%" fill="var(--accent)"><title>${tooltipFn(i, bins[i])}</title></rect>`;
    if (bins[i] > 0) {
      html += `<text x="${X(cx)}%" y="${Y(baseY - bh - 4)}%" fill="var(--muted)" font-size="11" text-anchor="middle">${bins[i]}</text>`;
    }
    if (labels[i]) {
      html += `<text x="${X(cx)}%" y="${Y(h - 6)}%" fill="var(--muted)" font-size="11" text-anchor="middle">${labels[i]}</text>`;
    }
  }
  svgEl.innerHTML = html;
  if (uids && titleFn) {
    // Delegate one click handler on the SVG. Each bar carries data-bin so
    // we look up its uid list by index. Re-renders replace the children;
    // we set the handler each time on the still-stable svg element.
    svgEl.onclick = (e) => {
      const r = e.target.closest("rect[data-bin]");
      if (!r) return;
      const i = +r.dataset.bin;
      showUidPopup(titleFn(i), uids[i] || []);
    };
  }
}

const ACTIVITY_LABELS = ["1-3", "4-9", "10-29", "30-99", "100-299", "300-999", "1000-2999", "3000+"];
function renderActivityHist(bins, uids) {
  paintHist(
    activityhist.querySelector("svg"),
    600, 200,
    bins || new Array(8).fill(0),
    ACTIVITY_LABELS,
    (i, n) => `${ACTIVITY_LABELS[i]} answers: ${n} users`,
    uids,
    (i) => `${ACTIVITY_LABELS[i]} answers`,
  );
}

// Sparse labels at 1, 5, 10, 15, 20, 25, 30, 30+ so the x-axis isn't crowded.
const DAYS_LABELS = (() => {
  const a = new Array(31).fill("");
  for (const i of [0, 4, 9, 14, 19, 24, 29]) a[i] = String(i + 1);
  a[30] = "30+";
  return a;
})();
const daysLabelFor = (i) => i === 30 ? "31+ days" : `${i + 1} day${i === 0 ? "" : "s"}`;
function renderDaysHist(bins, uids) {
  paintHist(
    dayshist.querySelector("svg"),
    800, 200,
    bins || new Array(31).fill(0),
    DAYS_LABELS,
    (i, n) => `${daysLabelFor(i)}: ${n} users`,
    uids,
    daysLabelFor,
  );
}

// ---------- uid drill-down popup ----------
// Renders a list of device IDs as links to the per-user dashboard. Closed
// via the × button, backdrop click, or Esc. No-op for empty buckets so a
// click on a zero-height bar produces nothing rather than an empty modal.
// `title` describes the bucket only (e.g. "あ行 level 5"); the count is
// appended here so callers don't need to track it.
function showUidPopup(title, uidList) {
  if (!uidList || uidList.length === 0) return;
  const popup = document.getElementById("uidpopup");
  const n = uidList.length;
  popup.querySelector(".uidpopup-title").textContent = `${title} — ${n} user${n === 1 ? "" : "s"}`;
  popup.querySelector(".uidpopup-list").innerHTML = uidList
    .map((u) => {
      const nick = nicknames[u];
      const nickHtml = nick ? `<span class="nick">${escapeHtml(nick)}</span>` : "";
      const tz = fmtTz(timezones[u]);
      const tzHtml = tz ? `<span class="tz">${tz}</span>` : "";
      return `<li><a href="../dashboard/?uid=${encodeURIComponent(u)}" target="_blank" rel="noopener"><span>${escapeHtml(u)}</span>${nickHtml}${tzHtml}</a></li>`;
    })
    .join("");
  popup.hidden = false;
}

// A push-subscription tz offset (minutes east of UTC) as "UTC±H[:MM]" — e.g.
// 540 → "UTC+9", 330 → "UTC+5:30". null/undefined (no reminder opt-in) → "".
function fmtTz(off) {
  if (off == null) return "";
  const abs = Math.abs(off), h = Math.floor(abs / 60), m = abs % 60;
  return `UTC${off < 0 ? "−" : "+"}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
}

// Escape before interpolating any client-supplied string (uids, nicknames)
// into innerHTML — both are arbitrary text the worker stored verbatim.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function hideUidPopup() {
  document.getElementById("uidpopup").hidden = true;
}

(() => {
  const popup = document.getElementById("uidpopup");
  popup.querySelector(".uidpopup-close").onclick = hideUidPopup;
  popup.querySelector(".uidpopup-backdrop").onclick = hideUidPopup;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popup.hidden) hideUidPopup();
  });

  // Click-to-play delegation on the sound-file confusion matrix (its row
  // headers play the recording). Bound on the stable parent so it survives each
  // redraw (which replaces only the inner HTML).
  voiceconf.addEventListener("click", (e) => {
    const th = e.target.closest("th.vname");
    if (!th) return;
    playVoice(th.dataset.mora, th.dataset.voice);
  });
})();

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

// ---------- sound-file confusion matrix (per recording) ----------
let voiceShownData = [];       // [{t, v, p, n}] — picks among opts-bearing answers
let voiceOfferedData = [];     // [{t, v, k, n}] — times kana k offered for (recording)

function renderVoiceConfusion(shownRows, offeredRows) {
  voiceShownData = shownRows || [];
  voiceOfferedData = offeredRows || [];
  vcmin.oninput = drawVoiceConfusion;
  vcwrong.oninput = drawVoiceConfusion;
  drawVoiceConfusion();
}

// Thin wrapper over the shared renderer — reads the page's filter inputs + mode.
function drawVoiceConfusion() {
  renderVoiceConf(voiceconf, voiceShownData, voiceOfferedData, {
    mode: displayMode,
    minA: Math.max(0, parseInt(vcmin.value, 10) || 0),
    minW: Math.max(0, parseInt(vcwrong.value, 10) || 0),
  });
}

// ---------- confusion (same shape as user dashboard, server-side counts) ----------
// A pick is normalised by how often that confuser kana was actually offered (the
// true pairwise confusion); answers with no offered set don't appear.
let confusionShown = null;      // t/p -> picks among opts-bearing answers (numerator)
let confusionOffered = null;    // t/p -> times kana p was on screen when t was asked (denominator)

function renderConfusion(shownRows, offeredRows) {
  const shown = {}, offered = {};
  for (const r of shownRows || []) shown[`${r.t}/${r.p}`] = r.n;
  for (const r of offeredRows || []) offered[`${r.t}/${r.k}`] = r.n;
  confusionShown = shown;
  confusionOffered = offered;
  drawConfusion();
}

function drawConfusion() {
  if (!confusionShown) return;
  const maps = { shown: confusionShown, offered: confusionOffered };
  fillConfusionCells(confchart.querySelectorAll("td[data-t]"), maps, displayMode);
  drawConsonantConfusion();
}

// Consonant matrix: collapses every vowel into confusion between the six
// consonant classes (s z ts sh j ch). Same data/display mode as the per-vowel
// matrix above, aggregated by consonant.
function drawConsonantConfusion() {
  if (!confusionShown) return;
  const maps = aggregateByConsonant({ shown: confusionShown, offered: confusionOffered });
  fillConfusionCells(conschart.querySelectorAll("td[data-t]"), maps, displayMode);
}

// ---------- helpers ----------
// (niceTicks now in src/shared/daychart.js)
