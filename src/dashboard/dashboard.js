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

const pad2 = (x) => ("0" + x).slice(-2);
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

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

// Reveal the load-form only if the viewer has power_user=1 on the server.
// Failure (no network, no row, 4xx) silently keeps the form hidden — the
// dashboard still renders the viewed user's data.
if (viewerUid) {
  fetch(STATS_URL + "/v1/user/" + encodeURIComponent(viewerUid))
    .then((r) => r.ok ? r.json() : null)
    .then((info) => { if (info && info.power_user) uidform.hidden = false; })
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

function renderOverview(uid, events) {
  const ag = events.filter((e) => e.ev === "a" || e.ev === "g");
  const correct = ag.filter((e) => e.picked === e.target).length;
  const acc = ag.length ? correct / ag.length : 0;
  // Day-boundary resets match the live app's streak rules — see app.js load()
  // and record(). Without this, topStreak could span multiple days and would
  // never match what the user actually saw in #streak.
  let topStreak = 0, run = 0, lastDay = null;
  for (const e of events) {
    if (e.ev !== "a" && e.ev !== "g" && e.ev !== "r") continue;
    const d = dayKey(e.ts);
    if (lastDay !== null && d !== lastDay) run = 0;
    lastDay = d;
    if (e.ev === "r") run = 0;
    else if (e.picked === e.target) { run++; if (run > topStreak) topStreak = run; }
    else run = 0;
  }
  const days = new Set(ag.map((e) => dayKey(e.ts))).size;
  const relisten = events.filter((e) => e.ev === "r").length;

  overview.querySelector(".uid").textContent = uid;
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
// Replays the same state machine the live app uses (LEVELS = [10,15,20,25])
// to derive the user's current per-vowel skill and cap. See src/app.js record().
const LEVELS = [10, 15, 20, 25];
const lastLevelIdx = (c) => {
  let i = -1;
  for (let k = 0; k < LEVELS.length; k++) if (c >= LEVELS[k]) i = k;
  return i;
};

function renderLevels(events) {
  const skill = { a: 0, i: 0, u: 0, o: 0 };
  const seen = { a: false, i: false, u: false, o: false };
  for (const e of events) {
    if (e.ev !== "a" && e.ev !== "g" && e.ev !== "r") continue;
    const v = e.target.slice(-1);
    if (!(v in skill)) continue;
    seen[v] = true;
    if (e.ev === "r") {
      const i = lastLevelIdx(skill[v]);
      skill[v] = i < 0 ? 0 : LEVELS[i];
    } else if (e.picked === e.target) {
      skill[v]++;
    } else {
      const i = lastLevelIdx(skill[v]);
      skill[v] = i <= 0 ? 0 : LEVELS[i - 1];
    }
  }
  for (const v of ["a", "i", "u", "o"]) {
    const row = document.querySelector(`#levels [data-vowel="${v}"]`);
    if (!row) continue;
    const c = skill[v];
    // "level" = number of choice buttons shown for this vowel = 2..6.
    const idx = lastLevelIdx(c);             // -1..3
    const cap = 3 + idx;                     // 2..6
    const next = LEVELS[idx + 1];            // threshold to next level (undefined at max)
    row.querySelector(".lvl-count").textContent = seen[v] ? c : "—";
    row.querySelector(".lvl-level").textContent = seen[v] ? `level ${cap}` : "—";
    row.querySelector(".lvl-next").textContent = next != null && seen[v]
      ? `${next - c} to lvl ${cap + 1}`
      : (seen[v] ? "max" : "");
    // Progress bar inside current level
    const start = idx < 0 ? 0 : LEVELS[idx];
    const end = next != null ? next : c;
    const pct = end > start ? Math.max(0, Math.min(1, (c - start) / (end - start))) : 1;
    row.querySelector(".lvl-fill").style.width = (pct * 100) + "%";
  }
}

// ---------- daily ----------
function renderDaily(events) {
  const ag = events.filter((e) => e.ev === "a" || e.ev === "g");
  const map = new Map();
  for (const e of ag) {
    const k = dayKey(e.ts);
    const v = map.get(k) || { correct: 0, wrong: 0 };
    if (e.picked === e.target) v.correct++; else v.wrong++;
    map.set(k, v);
  }
  const first = new Date(events[0].ts); first.setHours(0, 0, 0, 0);
  const last = new Date(events[events.length - 1].ts); last.setHours(0, 0, 0, 0);
  const days = [];
  for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const v = map.get(k) || { correct: 0, wrong: 0 };
    days.push({ k, ...v, total: v.correct + v.wrong });
  }
  const max = Math.max(1, ...days.map((d) => d.total));
  // Fixed viewBox so the rendered height matches the container's aspect-ratio
  // regardless of how many days the user has. Bars scale to fit.
  const w = 960, h = 200;
  const innerH = h - 40;
  const bw = (w - 40) / Math.max(1, days.length);
  let bars = "", labels = "";
  let lastMonth = "";
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const x = 20 + i * bw;
    const totH = d.total / max * innerH;
    const cH = d.total ? d.correct / d.total * totH : 0;
    const tip = `${d.k}  ${d.correct}/${d.total}`;
    if (d.total) {
      bars += `<rect x="${x}" y="${h - 20 - totH}" width="${bw * 0.8}" height="${totH}" fill="var(--bad)"><title>${tip}</title></rect>`;
      bars += `<rect x="${x}" y="${h - 20 - cH}" width="${bw * 0.8}" height="${cH}" fill="var(--good)"><title>${tip}</title></rect>`;
    }
    const month = d.k.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      labels += `<text x="${x}" y="${h - 4}" fill="var(--muted)" font-size="10">${month}</text>`;
    }
  }
  let axis = "";
  for (const t of niceTicks(max)) {
    const y = h - 20 - t / max * innerH;
    axis += `<text x="0" y="${y + 3}" fill="var(--muted)" font-size="10">${t}</text>`;
    axis += `<line x1="20" x2="${w}" y1="${y}" y2="${y}" stroke="var(--panel-2)" stroke-width=".5"/>`;
  }
  dailychart.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${axis}${bars}${labels}</svg>`;
}

// ---------- hourly ----------
function renderHourly(events) {
  const ag = events.filter((e) => e.ev === "a" || e.ev === "g");
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

// ---------- per-mora ----------
// Updates the 19 static .mrow elements in dashboard.html; each carries its
// own data-mora attribute, so we only set widths and the text readout.
function renderMora(events) {
  const counts = {};
  for (const e of events) {
    if (e.ev !== "a" && e.ev !== "g") continue;
    const c = counts[e.target] || (counts[e.target] = { correct: 0, total: 0 });
    c.total++;
    if (e.picked === e.target) c.correct++;
  }
  const maxN = Math.max(1, ...Object.values(counts).map((c) => c.total));
  for (const mrow of morachart.querySelectorAll(".mrow")) {
    const c = counts[mrow.dataset.mora] || { correct: 0, total: 0 };
    const accPct = c.total ? c.correct / c.total : 0;
    mrow.querySelector(".mbar-total").style.width = (c.total / maxN * 100) + "%";
    mrow.querySelector(".mbar-correct").style.width = (accPct * 100) + "%";
    mrow.querySelector(".mtxt").textContent = c.total
      ? `${c.correct}/${c.total} · ${(accPct * 100).toFixed(0)}%`
      : "0/0";
  }
}

// ---------- confusion ----------
// Walks the static td[data-t][data-p] cells across all four vowel-group tables.
// Color intensity is per-category (diag vs off-diag) so off-diagonal errors
// don't get drowned out by big correct counts.
function renderConfusion(events) {
  const counts = {};
  for (const e of events) {
    if (e.ev !== "a" && e.ev !== "g") continue;
    const k = `${e.target}/${e.picked}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  const cells = confchart.querySelectorAll("td[data-t]");
  let maxOn = 0, maxOff = 0;
  for (const td of cells) {
    const n = counts[`${td.dataset.t}/${td.dataset.p}`] || 0;
    if (td.dataset.t === td.dataset.p) maxOn = Math.max(maxOn, n);
    else maxOff = Math.max(maxOff, n);
  }
  for (const td of cells) {
    const n = counts[`${td.dataset.t}/${td.dataset.p}`] || 0;
    const diag = td.dataset.t === td.dataset.p;
    let bg = "transparent";
    if (n > 0) {
      const a = diag ? (maxOn ? n / maxOn : 0) : (maxOff ? n / maxOff : 0);
      const base = diag ? "var(--good)" : "var(--bad)";
      const pct = Math.round((diag ? 15 : 20) + a * (diag ? 55 : 60));
      bg = `color-mix(in srgb, ${base} ${pct}%, transparent)`;
    }
    td.style.background = bg;
    td.textContent = n || "";
    td.classList.toggle("empty", n === 0);
  }
}

// ---------- streak ----------
// Per-day *peak* streak as a bar chart with a calendar-uniform x-axis. The
// previous "polyline of every event's run" version made a misleading
// diagonal across days with no activity. Daily peaks read cleanly and align
// with the daily-activity chart's x-axis.
function renderStreak(events) {
  const peaks = new Map();          // YYYY-MM-DD → max run that day
  let run = 0;
  let lastDay = null;
  for (const e of events) {
    if (e.ev !== "a" && e.ev !== "g" && e.ev !== "r") continue;
    const d = dayKey(e.ts);
    if (lastDay !== null && d !== lastDay) run = 0;
    lastDay = d;
    if (e.ev === "r") run = 0;
    else if (e.picked === e.target) run++;
    else run = 0;
    if (run > (peaks.get(d) || 0)) peaks.set(d, run);
  }
  if (peaks.size === 0) { streakchart.textContent = "(no answers)"; return; }

  const first = new Date(events[0].ts); first.setHours(0, 0, 0, 0);
  const last = new Date(events[events.length - 1].ts); last.setHours(0, 0, 0, 0);
  const days = [];
  for (const dt = new Date(first); dt <= last; dt.setDate(dt.getDate() + 1)) {
    const k = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
    days.push({ k, run: peaks.get(k) || 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.run));
  const w = 960, h = 160;
  const innerH = h - 40;
  const bw = (w - 40) / Math.max(1, days.length);
  let bars = "", labels = "";
  let lastMonth = "";
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const x = 20 + i * bw;
    const bh = d.run / max * innerH;
    if (d.run > 0) {
      bars += `<rect x="${x}" y="${h - 20 - bh}" width="${bw * 0.8}" height="${bh}" fill="var(--accent)"><title>${d.k}  peak streak ${d.run}</title></rect>`;
    }
    const month = d.k.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      labels += `<text x="${x}" y="${h - 4}" fill="var(--muted)" font-size="10">${month}</text>`;
    }
  }
  let axis = "";
  for (const t of niceTicks(max)) {
    const y = h - 20 - t / max * innerH;
    axis += `<text x="0" y="${y + 3}" fill="var(--muted)" font-size="10">${t}</text>`;
    axis += `<line x1="20" x2="${w}" y1="${y}" y2="${y}" stroke="var(--panel-2)" stroke-width=".5"/>`;
  }
  streakchart.innerHTML =
    `<svg viewBox="0 0 ${w} ${h}">${axis}${bars}${labels}<text x="${w - 20}" y="14" fill="var(--muted)" font-size="11" text-anchor="end">peak: ${max}</text></svg>`;
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
