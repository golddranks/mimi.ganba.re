// Power-user-only app-wide aggregate dashboard. Pulls /v1/admin/stats and
// fans the result out into the static skeleton declared in admin/index.html.
// Auth is the requester's own uid (URL ?uid= or localStorage.uid); the worker
// checks users.power_user. No PII leaves the worker — only aggregates.

// When served from localhost (via scripts/dev.sh) hit the local wrangler dev
// worker so the admin panel reflects local-DB events rather than production.
const STATS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? `http://${location.hostname}:8787`
  : "https://mimi-stats.golddranks.workers.dev";

const pad2 = (x) => ("0" + x).slice(-2);

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
    renderOverview(data);
    renderLevelHist(data.level_hist);
    renderDaysHist(data.days_hist);
    renderActivityHist(data.activity_hist);
    renderDaily(data.daily);
    renderHourly(data.hourly);
    renderMora(data.by_mora);
    renderVoice(data.by_voice, data.by_voice_played);
    renderVoiceConfusion(data.by_voice_confusion);
    renderConfusion(data.confusion);
  } catch (e) {
    msg.textContent = "Error: " + (e && e.message);
  }
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
function renderDaily(daily) {
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
  const bw = (w - 40) / Math.max(1, days.length);
  let bars = "", labels = "";
  let lastMonth = "";
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const x = 20 + i * bw;
    const totH = d.n / max * innerH;
    const cH = d.n ? d.correct / d.n * totH : 0;
    const tip = `${d.k}  ${d.correct}/${d.n}`;
    if (d.n) {
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

// ---------- user-level histograms per vowel ----------
// Bins 0..4 correspond to caps 2..6 (= number of choice buttons shown for
// questions at that level; see LEVELS = [10,15,20,25] in app.js). The
// static skeleton for the 4 charts lives in admin/index.html; this only
// updates bar heights, count labels, and tooltips, so the layout is fixed
// from first paint and the section doesn't flash blank.
function renderLevelHist(hist) {
  const data = hist || { a: [0, 0, 0, 0, 0], i: [0, 0, 0, 0, 0], u: [0, 0, 0, 0, 0], o: [0, 0, 0, 0, 0] };
  const baseY = 118, innerH = 104; // must match the static SVG geometry
  for (const v of ["a", "i", "u", "o"]) {
    const bins = data[v] || [0, 0, 0, 0, 0];
    const total = bins.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...bins);
    const col = levelhist.querySelector(`.lvlcol[data-vowel="${v}"]`);
    col.querySelector(".lvltotal").textContent = total;
    for (let i = 0; i < 5; i++) {
      const bh = bins[i] / max * innerH;
      const rect = col.querySelector(`rect[data-bin="${i}"]`);
      rect.setAttribute("height", bh);
      rect.setAttribute("y", baseY - bh);
      rect.querySelector("title").textContent = `level ${i + 2}: ${bins[i]} users`;
      const text = col.querySelector(`text.bincount[data-bin="${i}"]`);
      text.setAttribute("y", baseY - bh - 2);
      text.textContent = bins[i] || "";
    }
  }
}

// ---------- distribution histograms (activity / days) ----------
// Generic painter for an N-bin histogram. The outer `<svg>` (with its
// viewBox) lives statically in admin/index.html so the section reserves
// its layout; this function fills in the bars + axis labels on data load.
// `labels[i]` is shown under bar i (use "" to suppress for crowded x-axes).
function paintHist(svgEl, bins, labels, tooltipFn) {
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
    html += `<rect x="${cx - barW / 2}" y="${baseY - bh}" width="${barW}" height="${bh}" fill="var(--accent)"><title>${tooltipFn(i, bins[i])}</title></rect>`;
    if (bins[i] > 0) {
      html += `<text x="${cx}" y="${baseY - bh - 4}" fill="var(--muted)" font-size="11" text-anchor="middle">${bins[i]}</text>`;
    }
    if (labels[i]) {
      html += `<text x="${cx}" y="${vbh - 6}" fill="var(--muted)" font-size="11" text-anchor="middle">${labels[i]}</text>`;
    }
  }
  svgEl.innerHTML = html;
}

const ACTIVITY_LABELS = ["1-3", "4-9", "10-29", "30-99", "100-299", "300-999", "1000-2999", "3000+"];
function renderActivityHist(bins) {
  paintHist(
    activityhist.querySelector("svg"),
    bins || new Array(8).fill(0),
    ACTIVITY_LABELS,
    (i, n) => `${ACTIVITY_LABELS[i]} answers: ${n} users`,
  );
}

// Sparse labels at 1, 5, 10, 15, 20, 25, 30, 30+ so the x-axis isn't crowded.
const DAYS_LABELS = (() => {
  const a = new Array(31).fill("");
  for (const i of [0, 4, 9, 14, 19, 24, 29]) a[i] = String(i + 1);
  a[30] = "30+";
  return a;
})();
function renderDaysHist(bins) {
  paintHist(
    dayshist.querySelector("svg"),
    bins || new Array(31).fill(0),
    DAYS_LABELS,
    (i, n) => (i === 30 ? "31+ days" : `${i + 1} day${i === 0 ? "" : "s"}`) + `: ${n} users`,
  );
}

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

// ---------- per-mora difficulty ----------
// Reorders the static .mrow elements so hardest (lowest accuracy with at
// least 1 attempt) comes first; unattempted morae sink to the bottom.
function renderMora(byMora) {
  const counts = {};
  for (const r of byMora || []) counts[r.m] = { n: r.n, correct: r.correct };
  const rows = [...morachart.querySelectorAll(".mrow")];
  const maxN = Math.max(1, ...rows.map((r) => (counts[r.dataset.mora] || {}).n || 0));
  // Sort: attempted rows by accuracy ascending; unattempted at the end.
  rows.sort((a, b) => {
    const ca = counts[a.dataset.mora] || { n: 0, correct: 0 };
    const cb = counts[b.dataset.mora] || { n: 0, correct: 0 };
    if (!ca.n && !cb.n) return 0;
    if (!ca.n) return 1;
    if (!cb.n) return -1;
    return (ca.correct / ca.n) - (cb.correct / cb.n);
  });
  for (const mrow of rows) {
    morachart.appendChild(mrow);
    const c = counts[mrow.dataset.mora] || { n: 0, correct: 0 };
    const acc = c.n ? c.correct / c.n : 0;
    mrow.querySelector(".mbar-total").style.width = (c.n / maxN * 100) + "%";
    mrow.querySelector(".mbar-correct").style.width = (acc * 100) + "%";
    mrow.querySelector(".mtxt").textContent = c.n
      ? `${c.correct}/${c.n} · ${(acc * 100).toFixed(0)}%`
      : "0/0";
  }
}

// ---------- sound-file difficulty ----------
const DISPLAY = {
  sa: "さ", za: "ざ", sya: "しゃ", zya: "じゃ", tya: "ちゃ",
  si: "し", zi: "じ", ti: "ち",
  su: "す", zu: "ず", tu: "つ", syu: "しゅ", zyu: "じゅ", tyu: "ちゅ",
  so: "そ", zo: "ぞ", syo: "しょ", zyo: "じょ", tyo: "ちょ",
};

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
  vmin.oninput = redrawVoice;
  vlisten.oninput = redrawVoice;
  vtop.oninput = redrawVoice;
  drawVoiceTable();
}

// Sum of re-listens + after-plays — the "uncertainty after hearing this
// recording" signal. High values at low attempt counts often indicate an
// unclear or wrong recording.
const listenCount = (r) => (r.relisten || 0) + (r.afterplay || 0);

function renderVoiceConfusion(rows) {
  voiceConfData = rows || [];
  drawVoiceConfusion();
}

function redrawVoice() {
  drawVoiceTable();
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
  tbody.innerHTML = rows.map((r) => {
    const accPct = r.n ? (r.acc * 100).toFixed(1) + "%" : "—";
    const cls = r.n === 0 ? "" : r.acc < 0.6 ? "bad" : r.acc < 0.85 ? "mid" : "";
    return `<tr>
      <td>${DISPLAY[r.m] || r.m}</td>
      <td>${r.v || "?"}</td>
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
  const min = Math.max(1, parseInt(vmin.value, 10) || 1);
  const minL = Math.max(0, parseInt(vlisten.value, 10) || 0);
  const map = window.VOICE_MAP || {};
  const counts = {};
  const totals = {};
  for (const r of voiceConfData) {
    counts[`${r.t}/${r.v}/${r.p}`] = r.n;
    totals[`${r.t}/${r.v}`] = (totals[`${r.t}/${r.v}`] || 0) + r.n;
  }
  // Look up post-error listens per recording from the merged voiceData so
  // we can apply the same OR filter as the difficulty table above.
  const listens = {};
  for (const r of voiceData) listens[`${r.m}/${r.v}`] = listenCount(r);

  const html = [];
  for (const v of ["a", "i", "u", "o"]) {
    const morae = VOWEL_GROUPS[v];

    const rowsInGroup = [];
    for (const m of morae) {
      for (const voice of map[m] || []) {
        const key = `${m}/${voice}`;
        const attempts = totals[key] || 0;
        const listenN = listens[key] || 0;
        if (attempts >= min || listenN >= minL) rowsInGroup.push({ m, voice });
      }
    }

    let maxOn = 0, maxOff = 0;
    for (const row of rowsInGroup) {
      for (const p of morae) {
        const n = counts[`${row.m}/${row.voice}/${p}`] || 0;
        if (row.m === p) maxOn = Math.max(maxOn, n);
        else maxOff = Math.max(maxOff, n);
      }
    }

    let header = `<tr><th></th><th></th>`;
    for (const p of morae) header += `<th>${DISPLAY[p]}</th>`;
    header += `</tr>`;

    let body = "";
    for (const row of rowsInGroup) {
      body += `<tr><th class="vmora">${DISPLAY[row.m]}</th><th class="vname">${row.voice}</th>`;
      for (const p of morae) {
        const n = counts[`${row.m}/${row.voice}/${p}`] || 0;
        const diag = row.m === p;
        let bg = "transparent";
        if (n > 0) {
          const a = diag ? (maxOn ? n / maxOn : 0) : (maxOff ? n / maxOff : 0);
          const base = diag ? "var(--good)" : "var(--bad)";
          const pct = Math.round((diag ? 15 : 20) + a * (diag ? 55 : 60));
          bg = `color-mix(in srgb, ${base} ${pct}%, transparent)`;
        }
        const cls = ((diag ? "diag" : "") + (n === 0 ? " empty" : "")).trim();
        body += `<td class="${cls}" style="background:${bg}" title="${row.m} (${row.voice}) → ${p}: ${n}">${n || ""}</td>`;
      }
      body += `</tr>`;
    }

    html.push(`<div class="confgroup">
      <h3>${VOWEL_GYO[v]}</h3>
      <table class="vconfgrid">
        <thead>${header}</thead>
        <tbody>${body || `<tr><td colspan="${2 + morae.length}" style="text-align:left;color:var(--muted);padding:.4rem 0">no recordings meet the min-attempts threshold</td></tr>`}</tbody>
      </table>
    </div>`);
  }
  voiceconf.innerHTML = html.join("");
}

// ---------- confusion (same shape as user dashboard, server-side counts) ----------
function renderConfusion(rows) {
  const counts = {};
  for (const r of rows || []) counts[`${r.t}/${r.p}`] = r.n;
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

// ---------- helpers ----------
function niceTicks(max) {
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const m = max / exp;
  const step = m < 2 ? 0.5 * exp : m < 5 ? 1 * exp : 2 * exp;
  const out = [];
  for (let t = step; t <= max; t += step) out.push(Math.round(t));
  return out;
}
