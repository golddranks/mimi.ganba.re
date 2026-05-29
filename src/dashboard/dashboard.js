import { LEVELS, levelIdx, capFor, onCorrect, onWrong, onRelisten } from "../shared/skill.js";
import { pad2, dateKey, dayKey } from "../shared/dates.js";

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

// Event-kind predicates: 'a'/'g' are answers; 'r' is a re-listen; 'p' is an
// after-play replay (never counted here).
const isAnswer = (e) => e.ev === "a" || e.ev === "g";
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

if (uid) {
  uidinput.value = uid;
  load(uid);
}

// Reveal the load-form only for level-2 power users (viewing arbitrary uids
// is per-user data, the same tier the admin uid-drilldowns sit behind). Level
// 1 sees only the aggregate admin sections, not individual users. Failure
// (no network, no row, 4xx) silently keeps the form hidden — the dashboard
// still renders the viewed user's data.
if (viewerUid) {
  fetch(STATS_URL + "/v1/user/" + encodeURIComponent(viewerUid))
    .then((r) => r.ok ? r.json() : null)
    .then((info) => { if (info && info.power_user >= 2) uidform.hidden = false; })
    .catch(() => { });
}

// First paint shows the dash skeleton (zeros + reserved chart space). #msg
// stays empty (and therefore display:none) during the loading window, so the
// dash doesn't shift when we'd otherwise hide a "Loading…" line. CSS handles
// the no-uid prompt via ::before; JS only writes to #msg for error states.
async function load(uid) {
  try {
    const res = await fetch(STATS_URL + "/v1/user/" + encodeURIComponent(uid) + "/events");
    if (!res.ok) { msg.textContent = `Fetch failed: HTTP ${res.status}`; return; }
    const { events } = await res.json();
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
    const d = dayKey(e.ts);
    if (lastDay !== null && d !== lastDay) run = 0;
    lastDay = d;
    if (e.ev === "r") run = 0;
    else if (e.picked === e.target) run++;
    else run = 0;
    if (run > (peaks.get(d) || 0)) peaks.set(d, run);
  }
  return peaks;
}

function renderOverview(uid, events) {
  const ag = events.filter(isAnswer);
  const correct = ag.filter((e) => e.picked === e.target).length;
  const acc = ag.length ? correct / ag.length : 0;
  const topStreak = Math.max(0, ...dailyPeakStreaks(events).values());
  const days = new Set(ag.map((e) => dayKey(e.ts))).size;
  const relisten = events.filter((e) => e.ev === "r").length;

  overview.querySelector(".uid .uid-value").textContent = uid;
  setStat("answers", ag.length);
  setStat("correct", correct);
  setStat("accuracy", (acc * 100).toFixed(1) + "%");
  setStat("topstreak", topStreak);
  setStat("days", days);
  setStat("relisten", relisten);
  setStat("first", dayKey(events[0].ts));
  setStat("last", dayKey(events[events.length - 1].ts));
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
    if (e.ev === "r") skill[v] = onRelisten(skill[v]);
    else if (e.picked === e.target) skill[v] = onCorrect(skill[v]);
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
// Calendar-uniform list of days from the first event to the last (inclusive),
// each as { k, ...valueFor(k) }.
function calendarDays(events, valueFor) {
  const first = new Date(events[0].ts); first.setHours(0, 0, 0, 0);
  const last = new Date(events[events.length - 1].ts); last.setHours(0, 0, 0, 0);
  const days = [];
  for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const k = dateKey(d);
    days.push({ k, ...valueFor(k) });
  }
  return days;
}

// Day-bar chart into `el` (fixed 960×h viewBox; bottom 20 units are the label
// gutter). Bins cap at 18 viewBox units and right-anchor — newest day flush
// right, short ranges leave the left empty rather than smearing thinly, like
// the app's #topbar. `mag(d)` is the bar magnitude (drives the y-axis scale);
// `bar(d, x, barW, bh, y0)` returns the SVG for one day's bar(s); optional
// `annotate(max)` adds a corner label.
function dayBarChart(el, days, h, mag, bar, annotate = () => "") {
  const w = 960, innerH = h - 40, y0 = h - 20;
  const max = Math.max(1, ...days.map(mag));
  const binW = Math.min((w - 40) / Math.max(1, days.length), 18);
  const barW = Math.min(binW * 0.8, 14);
  const xRightmost = w - 20 - barW;
  let bars = "", labels = "", lastMonth = "";
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const x = xRightmost - (days.length - 1 - i) * binW;
    if (mag(d) > 0) bars += bar(d, x, barW, mag(d) / max * innerH, y0);
    const month = d.k.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      labels += `<text x="${x}" y="${h - 4}" fill="var(--muted)" font-size="10">${month}</text>`;
    }
  }
  let axis = "";
  for (const t of niceTicks(max)) {
    const y = y0 - t / max * innerH;
    axis += `<text x="0" y="${y + 3}" fill="var(--muted)" font-size="10">${t}</text>`;
    axis += `<line x1="20" x2="${w}" y1="${y}" y2="${y}" stroke="var(--panel-2)" stroke-width=".5"/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${axis}${bars}${labels}${annotate(max)}</svg>`;
}

function renderDaily(events) {
  const map = new Map();
  for (const e of events) {
    if (!isAnswer(e)) continue;
    const k = dayKey(e.ts);
    const v = map.get(k) || { correct: 0, wrong: 0 };
    if (e.picked === e.target) v.correct++; else v.wrong++;
    map.set(k, v);
  }
  const days = calendarDays(events, (k) => {
    const v = map.get(k) || { correct: 0, wrong: 0 };
    return { ...v, total: v.correct + v.wrong };
  });
  dayBarChart(dailychart, days, 200, (d) => d.total, (d, x, barW, bh, y0) => {
    const cH = d.correct / d.total * bh;
    const tip = `${d.k}  ${d.correct}/${d.total}`;
    return `<rect x="${x}" y="${y0 - bh}" width="${barW}" height="${bh}" fill="var(--bad)"><title>${tip}</title></rect>`
      + `<rect x="${x}" y="${y0 - cH}" width="${barW}" height="${cH}" fill="var(--good)"><title>${tip}</title></rect>`;
  });
}

// ---------- hourly ----------
function renderHourly(events) {
  const ag = events.filter(isAnswer);
  const hrs = Array.from({ length: 24 }, () => ({ correct: 0, wrong: 0 }));
  for (const e of ag) {
    const hour = new Date(e.ts).getHours();
    if (e.picked === e.target) hrs[hour].correct++; else hrs[hour].wrong++;
  }
  const max = Math.max(1, ...hrs.map((h) => h.correct + h.wrong));
  const w = 480, h = 180;
  const innerH = h - 40;
  const bw = (w - 40) / 24;
  let bars = "", labels = "";
  for (let i = 0; i < 24; i++) {
    const x = 20 + i * bw;
    const tot = hrs[i].correct + hrs[i].wrong;
    const totH = tot / max * innerH;
    const cH = tot ? hrs[i].correct / tot * totH : 0;
    const tip = `${pad2(i)}:00  ${hrs[i].correct}/${tot}`;
    if (tot) {
      bars += `<rect x="${x}" y="${h - 20 - totH}" width="${bw * 0.8}" height="${totH}" fill="var(--bad)"><title>${tip}</title></rect>`;
      bars += `<rect x="${x}" y="${h - 20 - cH}" width="${bw * 0.8}" height="${cH}" fill="var(--good)"><title>${tip}</title></rect>`;
    }
    if (i % 3 === 0) {
      labels += `<text x="${x + bw * 0.4}" y="${h - 4}" fill="var(--muted)" font-size="10" text-anchor="middle">${i}</text>`;
    }
  }
  hourlychart.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${bars}${labels}</svg>`;
}

// ---------- display mode (shared) ----------
// Per-sound and confusion both honour the same count/per-sound-% toggle. Each section
// has its own .modeswitch in the h2 — clicking either updates the shared
// `displayMode` and re-runs both renderers (the toggles stay in sync).
let displayMode = "count";

// ---------- per-mora ----------
// Updates the 19 static .mrow elements in dashboard.html; each carries its
// own data-mora attribute, so we only set widths and the text readout.
let moraCounts = null;
let moraMaxN = 1;

function renderMora(events) {
  const counts = {};
  for (const e of events) {
    if (!isAnswer(e)) continue;
    const c = counts[e.target] || (counts[e.target] = { correct: 0, total: 0 });
    c.total++;
    if (e.picked === e.target) c.correct++;
  }
  moraCounts = counts;
  moraMaxN = Math.max(1, ...Object.values(counts).map((c) => c.total));
  drawMora();
}

function drawMora() {
  if (!moraCounts) return;
  for (const mrow of morachart.querySelectorAll(".mrow")) {
    const c = moraCounts[mrow.dataset.mora] || { correct: 0, total: 0 };
    const accPct = c.total ? c.correct / c.total : 0;
    const total = mrow.querySelector(".mbar-total");
    const correct = mrow.querySelector(".mbar-correct");
    const txt = mrow.querySelector(".mtxt");
    if (displayMode === "pct") {
      // Equal-width bars so accuracy is comparable across rows regardless of volume.
      total.style.width = c.total ? "100%" : "0%";
      correct.style.width = (accPct * 100) + "%";
      txt.textContent = c.total ? `${Math.round(accPct * 100)}%` : "—";
    } else {
      total.style.width = (c.total / moraMaxN * 100) + "%";
      correct.style.width = (accPct * 100) + "%";
      txt.textContent = c.total
        ? `${c.correct}/${c.total} · ${(accPct * 100).toFixed(0)}%`
        : "0/0";
    }
  }
}

// ---------- confusion ----------
// Walks the static td[data-t][data-p] cells across all four vowel-group tables.
// Color intensity is per-category (diag vs off-diag) so off-diagonal errors
// don't get drowned out by big correct counts.
let confusionCounts = null;
let confusionRowTotals = null;

function renderConfusion(events) {
  const counts = {};
  const rowTotals = {};
  for (const e of events) {
    if (!isAnswer(e)) continue;
    counts[`${e.target}/${e.picked}`] = (counts[`${e.target}/${e.picked}`] || 0) + 1;
    rowTotals[e.target] = (rowTotals[e.target] || 0) + 1;
  }
  confusionCounts = counts;
  confusionRowTotals = rowTotals;
  drawConfusion();
}

function drawConfusion() {
  if (!confusionCounts) return;
  const cells = confchart.querySelectorAll("td[data-t]");
  // value{display, mag, raw} — mag drives colour, display is the textContent.
  const valueFor = (t, p) => {
    const n = confusionCounts[`${t}/${p}`] || 0;
    if (displayMode === "pct") {
      const rt = confusionRowTotals[t] || 0;
      const pct = rt > 0 ? n / rt * 100 : 0;
      let display = "";
      if (n > 0) {
        const r = Math.round(pct);
        display = r === 0 ? "<1" : String(r);
      }
      return { display, mag: pct, raw: n };
    }
    return { display: n ? String(n) : "", mag: n, raw: n };
  };

  let maxOn = 0, maxOff = 0;
  for (const td of cells) {
    const v = valueFor(td.dataset.t, td.dataset.p);
    if (td.dataset.t === td.dataset.p) maxOn = Math.max(maxOn, v.mag);
    else maxOff = Math.max(maxOff, v.mag);
  }
  for (const td of cells) {
    const v = valueFor(td.dataset.t, td.dataset.p);
    const diag = td.dataset.t === td.dataset.p;
    let bg = "transparent";
    if (v.mag > 0) {
      const a = diag ? (maxOn ? v.mag / maxOn : 0) : (maxOff ? v.mag / maxOff : 0);
      const base = diag ? "var(--good)" : "var(--bad)";
      const pct = Math.round((diag ? 15 : 20) + a * (diag ? 55 : 60));
      bg = `color-mix(in srgb, ${base} ${pct}%, transparent)`;
    }
    td.style.background = bg;
    td.textContent = v.display;
    td.classList.toggle("empty", v.raw === 0);
  }
}

// Hook up every .modeswitch once at module load. Clicking any of them flips
// the shared displayMode, syncs the active-button state across all switches,
// and re-renders the sections that honour the mode.
(() => {
  const switches = document.querySelectorAll(".modeswitch");
  for (const sw of switches) {
    sw.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      displayMode = btn.dataset.mode;
      for (const s of switches) {
        for (const b of s.querySelectorAll("button[data-mode]")) {
          b.classList.toggle("active", b.dataset.mode === displayMode);
        }
      }
      drawConfusion();
      drawMora();
    });
  }
})();

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
      `<rect x="${x}" y="${y0 - bh}" width="${barW}" height="${bh}" fill="var(--accent)"><title>${d.k}  peak streak ${d.run}</title></rect>`,
    (max) => `<text x="940" y="14" fill="var(--muted)" font-size="11" text-anchor="end">peak: ${max}</text>`);
}

// ---------- reaction time ----------
function renderRtime(events) {
  const ag = events.filter(
    (e) => (e.ev === "a" || e.ev === "g") && e.ms != null && e.ms >= 0 && e.ms < 20000
  );
  if (ag.length === 0) { rtchart.textContent = "(no timed answers)"; return; }
  const cap = 6000;
  const buckets = 30;
  const cb = new Array(buckets).fill(0);
  const wb = new Array(buckets).fill(0);
  for (const e of ag) {
    const b = Math.min(buckets - 1, Math.floor(e.ms / (cap / buckets)));
    if (e.picked === e.target) cb[b]++; else wb[b]++;
  }
  const mx = Math.max(1, ...cb, ...wb);
  const w = 900, h = 200;
  const innerH = h - 40;
  const bw = (w - 40) / buckets;
  let bars = "";
  for (let i = 0; i < buckets; i++) {
    const x = 20 + i * bw;
    const ch = cb[i] / mx * innerH;
    const wh = wb[i] / mx * innerH;
    const lo = Math.round(i * cap / buckets);
    const hi = Math.round((i + 1) * cap / buckets);
    bars += `<rect x="${x}" y="${h - 20 - ch}" width="${bw * 0.45}" height="${ch}" fill="var(--good)"><title>${lo}-${hi}ms: ${cb[i]} correct</title></rect>`;
    bars += `<rect x="${x + bw * 0.5}" y="${h - 20 - wh}" width="${bw * 0.45}" height="${wh}" fill="var(--bad)"><title>${lo}-${hi}ms: ${wb[i]} wrong</title></rect>`;
  }
  let axis = "";
  for (let t = 0; t <= cap; t += 1000) {
    const x = 20 + (t / cap) * (w - 40);
    axis += `<text x="${x}" y="${h - 4}" fill="var(--muted)" font-size="10" text-anchor="middle">${t / 1000}s</text>`;
  }
  rtchart.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${bars}${axis}</svg>`;
}

// ---------- helpers ----------
function niceTicks(max) {
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const m = max / exp;
  const step = m < 2 ? 0.5 * exp : m < 5 ? 1 * exp : 2 * exp;
  const out = [];
  for (let t = step; t <= max; t += step) out.push(Math.round(t));
  return out;
}
