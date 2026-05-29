import { pad2 } from "../main/dates.js";

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

// uid → nickname, populated on load. Used by showUidPopup to annotate the
// drill-down list. Empty object until the first /v1/admin/stats response.
let nicknames = {};

// Display mode shared across the three count/per-sound-% toggles (per-sound,
// confusion matrix, sound-file confusion). Clicking any of them updates
// every switch and re-renders all three sections.
let displayMode = "count";

// Hiragana for the kana the user picks (button-side); katakana for the
// sound the user heard (row-side). Same convention as the user dashboard.
const HIRAGANA = {
  sa: "さ", za: "ざ", sya: "しゃ", zya: "じゃ", tya: "ちゃ",
  si: "し", zi: "じ", ti: "ち",
  su: "す", zu: "ず", tu: "つ", syu: "しゅ", zyu: "じゅ", tyu: "ちゅ",
  so: "そ", zo: "ぞ", syo: "しょ", zyo: "じょ", tyo: "ちょ",
};
const KATAKANA = {
  sa: "サ", za: "ザ", sya: "シャ", zya: "ジャ", tya: "チャ",
  si: "シ", zi: "ジ", ti: "チ",
  su: "ス", zu: "ズ", tu: "ツ", syu: "シュ", zyu: "ジュ", tyu: "チュ",
  so: "ソ", zo: "ゾ", syo: "ショ", zyo: "ジョ", tyo: "チョ",
};

// Click-to-play for voice file names in the difficulty table and the
// sound-file confusion grid. Looks up the recording's index in the current
// VOICE_MAP (injected by build) and plays the bundled .opus relative to
// the admin page. Reuses one Audio instance so a second click cancels the
// previous playback.
const voiceAudio = new Audio();
function playVoice(mora, voice) {
  const list = (window.VOICE_MAP || {})[mora] || [];
  const idx = list.indexOf(voice);
  if (idx < 0) return;
  voiceAudio.src = `../audio/${mora.slice(-1)}/${mora}/${idx}.opus`;
  voiceAudio.currentTime = 0;
  voiceAudio.play().catch(() => { });
}

// uid resolution mirrors the no-uid head script so first paint matches behaviour.
// Pulled from localStorage by default (set by the main app); ?uid=… overrides
// for cases like a fresh browser or testing as a different power user.
const uid = new URLSearchParams(location.search).get("uid") || localStorage.getItem("uid") || "";

if (uid) load(uid);

async function load(uid) {
  try {
    const res = await fetch(STATS_URL + "/v1/admin/stats?uid=" + encodeURIComponent(uid));
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
    renderVoice(data.by_voice, data.by_voice_played);
    renderVoiceConfusion(data.by_voice_confusion);
    renderConfusion(data.confusion);
    // Per-user / uid-drilldown sections — only if level-2 authorizes them.
    loadUserStats(uid);
  } catch (e) {
    msg.textContent = "Error: " + (e && e.message);
  }
}

// Second-tier fetch. 403 (level-1 user) or any failure silently leaves the
// .l2only sections hidden — the page still shows the aggregate sections.
async function loadUserStats(uid) {
  try {
    const res = await fetch(STATS_URL + "/v1/admin/stats/users?uid=" + encodeURIComponent(uid));
    if (!res.ok) return;
    const data = await res.json();
    nicknames = data.nicknames || {};
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
  // Fill in any missing days between first and last so the x-axis is calendar-uniform.
  const first = new Date(daily[0].d + "T00:00:00Z");
  const last = new Date(daily[daily.length - 1].d + "T00:00:00Z");
  const map = new Map(daily.map((r) => [r.d, r]));
  const days = [];
  for (const d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    const r = map.get(k) || { n: 0, correct: 0 };
    days.push({ k, n: r.n, correct: r.correct });
  }
  const max = Math.max(1, ...days.map((d) => d.n));
  const w = 960, h = 200;
  const innerH = h - 40;
  // Each day gets a fixed bin (up to 18 units, shrinking on long histories
  // so we still fit). The newest day sits flush against the right edge
  // — short date ranges leave empty space on the left rather than smearing
  // thinly across the chart. Matches the main app's #topbar where today
  // is at the right end.
  const idealBin = (w - 40) / Math.max(1, days.length);
  const binW = Math.min(idealBin, 18);
  const barW = Math.min(binW * 0.8, 14);
  const xRightmost = w - 20 - barW;
  let bars = "", labels = "";
  let lastMonth = "";
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const x = xRightmost - (days.length - 1 - i) * binW;
    const totH = d.n / max * innerH;
    const cH = d.n ? d.correct / d.n * totH : 0;
    const tip = `${d.k}  ${d.correct}/${d.n}`;
    if (d.n) {
      bars += `<rect data-date="${d.k}" x="${x}" y="${h - 20 - totH}" width="${barW}" height="${totH}" fill="var(--bad)"><title>${tip}</title></rect>`;
      bars += `<rect data-date="${d.k}" x="${x}" y="${h - 20 - cH}" width="${barW}" height="${cH}" fill="var(--good)"><title>${tip}</title></rect>`;
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
  dailychart.onclick = (e) => {
    const r = e.target.closest("rect[data-date]");
    if (!r) return;
    const d = r.dataset.date;
    showUidPopup(d, (uids || {})[d] || []);
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
// Generic painter for an N-bin histogram. The outer `<svg>` (with its
// viewBox) lives statically in admin/index.html so the section reserves
// its layout; this function fills in the bars + axis labels on data load.
// `labels[i]` is shown under bar i (use "" to suppress for crowded x-axes).
// `tooltipFn(i, n)` builds the SVG <title> (hover text incl. count).
// If `uids` + `titleFn(i)` are provided, every bar gets a click handler
// that pops up the contributing device IDs as links to the per-user
// dashboard. `titleFn` returns the bucket name *without* a count — the
// popup appends it.
function paintHist(svgEl, bins, labels, tooltipFn, uids, titleFn) {
  const vb = svgEl.getAttribute("viewBox").split(" ").map(Number);
  const vbw = vb[2], vbh = vb[3];
  const padL = 14, padR = 14;
  const baseY = vbh - 22, innerH = baseY - 14;
  const n = bins.length;
  const bw = (vbw - padL - padR) / n;
  const barW = Math.max(2, bw * 0.78);
  const max = Math.max(1, ...bins);
  let html = "";
  for (let i = 0; i < n; i++) {
    const cx = padL + (i + 0.5) * bw;
    const bh = bins[i] / max * innerH;
    html += `<rect data-bin="${i}" x="${cx - barW / 2}" y="${baseY - bh}" width="${barW}" height="${bh}" fill="var(--accent)"><title>${tooltipFn(i, bins[i])}</title></rect>`;
    if (bins[i] > 0) {
      html += `<text x="${cx}" y="${baseY - bh - 4}" fill="var(--muted)" font-size="11" text-anchor="middle">${bins[i]}</text>`;
    }
    if (labels[i]) {
      html += `<text x="${cx}" y="${vbh - 6}" fill="var(--muted)" font-size="11" text-anchor="middle">${labels[i]}</text>`;
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
      return `<li><a href="../dashboard/?uid=${encodeURIComponent(u)}" target="_blank" rel="noopener"><span>${escapeHtml(u)}</span>${nickHtml}</a></li>`;
    })
    .join("");
  popup.hidden = false;
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

  // Count/per-sound-% toggle — three switches (per-sound, confusion, voiceconf)
  // sharing one displayMode. Clicking any of them syncs every switch's
  // active button and re-renders the three sections that honour the mode.
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
      drawMora();
      drawConfusion();
      drawVoiceConfusion();
    });
  }

  // Click-to-play delegations. Bound on stable parent elements so they
  // survive each redraw (which replaces only the inner HTML).
  voicetable.querySelector("tbody").addEventListener("click", (e) => {
    const td = e.target.closest("td.voice");
    if (!td) return;
    playVoice(td.dataset.mora, td.dataset.voice);
  });
  voiceconf.addEventListener("click", (e) => {
    const th = e.target.closest("th.vname");
    if (!th) return;
    playVoice(th.dataset.mora, th.dataset.voice);
  });
})();

// ---------- hourly (UTC) ----------
function renderHourly(hourly) {
  const hrs = Array.from({ length: 24 }, () => ({ n: 0, correct: 0 }));
  for (const r of hourly || []) hrs[r.h] = { n: r.n, correct: r.correct };
  const max = Math.max(1, ...hrs.map((h) => h.n));
  const w = 480, h = 180;
  const innerH = h - 40;
  const bw = (w - 40) / 24;
  let bars = "", labels = "";
  for (let i = 0; i < 24; i++) {
    const x = 20 + i * bw;
    const totH = hrs[i].n / max * innerH;
    const cH = hrs[i].n ? hrs[i].correct / hrs[i].n * totH : 0;
    const tip = `${pad2(i)}:00 UTC  ${hrs[i].correct}/${hrs[i].n}`;
    if (hrs[i].n) {
      bars += `<rect x="${x}" y="${h - 20 - totH}" width="${bw * 0.8}" height="${totH}" fill="var(--bad)"><title>${tip}</title></rect>`;
      bars += `<rect x="${x}" y="${h - 20 - cH}" width="${bw * 0.8}" height="${cH}" fill="var(--good)"><title>${tip}</title></rect>`;
    }
    if (i % 3 === 0) {
      labels += `<text x="${x + bw * 0.4}" y="${h - 4}" fill="var(--muted)" font-size="10" text-anchor="middle">${i}</text>`;
    }
  }
  hourlychart.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${bars}${labels}</svg>`;
}

// ---------- per-sound difficulty ----------
// Reorders the static .mrow elements so hardest (lowest accuracy with at
// least 1 attempt) comes first; unattempted sounds sink to the bottom.
let moraCounts = null;
let moraMaxN = 1;

function renderMora(byMora) {
  const counts = {};
  for (const r of byMora || []) counts[r.m] = { n: r.n, correct: r.correct };
  moraCounts = counts;
  moraMaxN = Math.max(1, ...Object.values(counts).map((c) => c.n || 0));
  drawMora();
}

function drawMora() {
  if (!moraCounts) return;
  const rows = [...morachart.querySelectorAll(".mrow")];
  rows.sort((a, b) => {
    const ca = moraCounts[a.dataset.mora] || { n: 0, correct: 0 };
    const cb = moraCounts[b.dataset.mora] || { n: 0, correct: 0 };
    if (!ca.n && !cb.n) return 0;
    if (!ca.n) return 1;
    if (!cb.n) return -1;
    return (ca.correct / ca.n) - (cb.correct / cb.n);
  });
  for (const mrow of rows) {
    morachart.appendChild(mrow);
    const c = moraCounts[mrow.dataset.mora] || { n: 0, correct: 0 };
    const acc = c.n ? c.correct / c.n : 0;
    const total = mrow.querySelector(".mbar-total");
    const correct = mrow.querySelector(".mbar-correct");
    const txt = mrow.querySelector(".mtxt");
    if (displayMode === "pct") {
      total.style.width = c.n ? "100%" : "0%";
      correct.style.width = (acc * 100) + "%";
      txt.textContent = c.n ? `${Math.round(acc * 100)}%` : "—";
    } else {
      total.style.width = (c.n / moraMaxN * 100) + "%";
      correct.style.width = (acc * 100) + "%";
      txt.textContent = c.n
        ? `${c.correct}/${c.n} · ${(acc * 100).toFixed(0)}%`
        : "0/0";
    }
  }
}

// ---------- sound-file difficulty ----------
const VOWEL_GROUPS = {
  a: ["sa", "za", "sya", "zya", "tya"],
  i: ["si", "zi", "ti"],
  u: ["su", "zu", "tu", "syu", "zyu", "tyu"],
  o: ["so", "zo", "syo", "zyo", "tyo"],
};
// "<row-head>行" — Japanese for "<vowel>-row in the 50-sound chart"
const VOWEL_GYO = { a: "あ行", i: "い行", u: "う行", o: "お行" };

let voiceData = [];
let voiceConfData = [];

function renderVoice(byVoice, byPlayed) {
  // Merge by_voice_played into voiceData so each row knows both:
  //   relisten   — 'r' events for this recording (it was the question's voice)
  //   afterplay  — this recording was the played voice in some 'p' event
  // by_voice doesn't include recordings that only appear as a played file
  // (e.g. never asked as a question), so start from the union of sources.
  const idx = new Map();
  for (const r of byVoice || []) {
    idx.set(r.m + "/" + r.v, { ...r, afterplay: 0 });
  }
  for (const r of byPlayed || []) {
    const key = r.m + "/" + r.v;
    const cur = idx.get(key);
    if (cur) cur.afterplay = r.n;
    else idx.set(key, { m: r.m, v: r.v, n: 0, correct: 0, relisten: 0, afterplay: r.n });
  }
  voiceData = [...idx.values()];
  vmin.oninput = drawVoiceTable;
  vlisten.oninput = drawVoiceTable;
  vtop.oninput = drawVoiceTable;
  drawVoiceTable();
}

// Sum of re-listens + after-plays — the "uncertainty after hearing this
// recording" signal. High values at low attempt counts often indicate an
// unclear or wrong recording.
const listenCount = (r) => (r.relisten || 0) + (r.afterplay || 0);

function renderVoiceConfusion(rows) {
  voiceConfData = rows || [];
  vcmin.oninput = drawVoiceConfusion;
  vcwrong.oninput = drawVoiceConfusion;
  drawVoiceConfusion();
}

function drawVoiceTable() {
  const min = Math.max(1, parseInt(vmin.value, 10) || 1);
  const minL = Math.max(0, parseInt(vlisten.value, 10) || 0);
  const top = Math.max(1, parseInt(vtop.value, 10) || 1);
  // OR semantic: keep a recording if it crosses either threshold. Lets a
  // 1-attempt recording with many post-error listens still surface.
  const filtered = voiceData
    .filter((r) => r.n >= min || listenCount(r) >= minL)
    .map((r) => ({ ...r, acc: r.n ? r.correct / r.n : 0 }))
    .sort((a, b) => a.acc - b.acc);
  const rows = filtered.slice(0, top);
  vcount.textContent = `(${filtered.length} match attempts≥${min} or listens≥${minL}; showing top ${rows.length})`;
  const tbody = voicetable.querySelector("tbody");
  // Voice cell is clickable (plays the recording). Sound column shows
  // katakana — that's the heard side.
  tbody.innerHTML = rows.map((r) => {
    const accPct = r.n ? (r.acc * 100).toFixed(1) + "%" : "—";
    const cls = r.n === 0 ? "" : r.acc < 0.6 ? "bad" : r.acc < 0.85 ? "mid" : "";
    const voiceCell = r.v
      ? `<td class="voice" data-mora="${r.m}" data-voice="${r.v}">${r.v}</td>`
      : `<td>?</td>`;
    return `<tr>
      <td>${KATAKANA[r.m] || r.m}</td>
      ${voiceCell}
      <td>${r.n}</td>
      <td>${r.correct}</td>
      <td class="acc ${cls}">${accPct}</td>
      <td>${r.relisten || 0}</td>
      <td>${r.afterplay || 0}</td>
    </tr>`;
  }).join("");
}

// Per-vowel-group, per-recording confusion. Rows = (mora, voice) recordings
// grouped by mora; columns = picked mora within the vowel group. The row
// list iterates the current build's VOICE_MAP so newly-added recordings
// appear immediately; recordings that have been removed from VOICE_MAP but
// still have history in the DB silently disappear (acceptable for an admin
// view of current files).
function drawVoiceConfusion() {
  const minA = Math.max(0, parseInt(vcmin.value, 10) || 0);
  const minW = Math.max(0, parseInt(vcwrong.value, 10) || 0);
  const map = window.VOICE_MAP || {};
  const counts = {};
  const totals = {};
  for (const r of voiceConfData) {
    counts[`${r.t}/${r.v}/${r.p}`] = r.n;
    totals[`${r.t}/${r.v}`] = (totals[`${r.t}/${r.v}`] || 0) + r.n;
  }

  // Worst off-diagonal cell in a row, as a percentage of the row total.
  // The filter is always pct-based (count thresholds whip wildly with row
  // popularity); the display-mode toggle only affects how cells are rendered.
  const rowMaxOffPct = (m, voice) => {
    const sib = VOWEL_GROUPS[m.slice(-1)] || [];
    const rt = totals[`${m}/${voice}`] || 0;
    if (rt === 0) return 0;
    let max = 0;
    for (const p of sib) {
      if (p === m) continue;
      const pct = (counts[`${m}/${voice}/${p}`] || 0) / rt * 100;
      if (pct > max) max = pct;
    }
    return max;
  };

  const html = [];
  for (const v of ["a", "i", "u", "o"]) {
    const morae = VOWEL_GROUPS[v];

    const rowsInGroup = [];
    for (const m of morae) {
      for (const voice of map[m] || []) {
        const key = `${m}/${voice}`;
        const attempts = totals[key] || 0;
        if (attempts < minA) continue;
        if (minW > 0 && rowMaxOffPct(m, voice) < minW) continue;
        rowsInGroup.push({ m, voice });
      }
    }

    // value{display, mag, raw} — same shape as drawConfusion's valueFor.
    const valueFor = (m, voice, p) => {
      const n = counts[`${m}/${voice}/${p}`] || 0;
      if (displayMode === "pct") {
        const rt = totals[`${m}/${voice}`] || 0;
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
    for (const row of rowsInGroup) {
      for (const p of morae) {
        const val = valueFor(row.m, row.voice, p);
        if (row.m === p) maxOn = Math.max(maxOn, val.mag);
        else maxOff = Math.max(maxOff, val.mag);
      }
    }

    let header = `<tr><th></th><th></th>`;
    for (const p of morae) header += `<th>${HIRAGANA[p]}</th>`;
    header += `</tr>`;

    let body = "";
    let lastMora = null;
    const spacer = `<tr class="moragap" aria-hidden="true"><td colspan="${2 + morae.length}"></td></tr>`;
    for (const row of rowsInGroup) {
      // Insert an empty spacer row when the mora changes. (Padding/border on
      // the cluster's first row gets eaten by the fixed td height under
      // box-sizing: border-box, so an explicit row is the only reliable way
      // to get visible whitespace between sound clusters.)
      if (row.m !== lastMora && body !== "") body += spacer;
      lastMora = row.m;
      // vname carries data-mora/data-voice for the click-to-play delegation
      // attached once at module load; vmora is katakana (heard side). The
      // voice name lives inside a span so it can ellipsis-truncate without
      // making the th itself wider than its max-width — table cells don't
      // honour text-overflow on their own.
      body += `<tr><th class="vmora">${KATAKANA[row.m]}</th><th class="vname" data-mora="${row.m}" data-voice="${row.voice}" title="${row.voice}"><span>${row.voice}</span></th>`;
      for (const p of morae) {
        const val = valueFor(row.m, row.voice, p);
        const diag = row.m === p;
        let bg = "transparent";
        if (val.mag > 0) {
          const a = diag ? (maxOn ? val.mag / maxOn : 0) : (maxOff ? val.mag / maxOff : 0);
          const base = diag ? "var(--good)" : "var(--bad)";
          const pct = Math.round((diag ? 15 : 20) + a * (diag ? 55 : 60));
          bg = `color-mix(in srgb, ${base} ${pct}%, transparent)`;
        }
        const cls = ((diag ? "diag" : "") + (val.raw === 0 ? " empty" : "")).trim();
        body += `<td class="${cls}" style="background:${bg}" title="${row.m} (${row.voice}) → ${p}: ${val.raw}">${val.display}</td>`;
      }
      body += `</tr>`;
    }

    html.push(`<div class="confgroup">
      <table class="vconfgrid">
        <thead>${header}</thead>
        <tbody>${body || `<tr><td colspan="${2 + morae.length}" style="text-align:left;color:var(--muted);padding:.4rem 0">no recordings meet the filters</td></tr>`}</tbody>
      </table>
    </div>`);
  }
  voiceconf.innerHTML = html.join("");
}

// ---------- confusion (same shape as user dashboard, server-side counts) ----------
let confusionCounts = null;
let confusionRowTotals = null;

function renderConfusion(rows) {
  const counts = {};
  const rowTotals = {};
  for (const r of rows || []) {
    counts[`${r.t}/${r.p}`] = r.n;
    rowTotals[r.t] = (rowTotals[r.t] || 0) + r.n;
  }
  confusionCounts = counts;
  confusionRowTotals = rowTotals;
  drawConfusion();
}

function drawConfusion() {
  if (!confusionCounts) return;
  const cells = confchart.querySelectorAll("td[data-t]");
  // value{display, mag, raw} — mag drives the colour, display is the text.
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

// ---------- helpers ----------
function niceTicks(max) {
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const m = max / exp;
  const step = m < 2 ? 0.5 * exp : m < 5 ? 1 * exp : 2 * exp;
  const out = [];
  for (let t = step; t <= max; t += step) out.push(Math.round(t));
  return out;
}
