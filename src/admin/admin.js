import { dayBarChart, dayTip, calendarSpan } from "../shared/daychart.js";

// Level-2 admin panel: per-user / uid-drilldown stats — everything here carries
// device identifiers. Fetches one endpoint into the static skeleton in
// admin/index.html:
//   /v1/admin/stats/users   (power_user >= 2) — per-user histograms, daily
//                                               activity, uid drilldowns
// The aggregate, identifier-free sections (the overview counters, hourly,
// per-sound, confusion matrices) live on the level-1 /stats/ page, which reads
// /v1/admin/stats instead.

// When served from localhost (via scripts/dev.sh) hit the local wrangler dev
// worker so the panel reflects local-DB events rather than production.
const STATS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? `http://${location.hostname}:8787`
  : "https://mimi-stats.golddranks.workers.dev";

// uid → nickname and uid → tz offset (minutes east of UTC, from push_subs),
// populated on load. Used by showUidPopup to annotate the drill-down list.
// Empty until the first /v1/admin/stats/users response.
let nicknames = {};
let timezones = {};

// uid resolution mirrors the no-uid head script so first paint matches behaviour.
// Pulled from localStorage by default (set by the main app); ?uid=… overrides
// for cases like a fresh browser or testing as a different power user.
const uid = new URLSearchParams(location.search).get("uid") || localStorage.getItem("uid") || "";

// No uid (e.g. a private window that never opened the app) can't be authorized,
// so skip the fetch and say so directly — otherwise load() never runs and the
// page would fall back to the bare CSS "Unauthorized." pseudo-element.
if (uid) load(uid);
else showUnauthorized("admin");

async function load(uid) {
  try {
    const res = await fetch(STATS_URL + "/v1/admin/stats/users?uid=" + encodeURIComponent(uid));
    if (res.status === 403) {
      showUnauthorized("admin");
      return;
    }
    if (!res.ok) { msg.textContent = `Fetch failed: HTTP ${res.status}`; return; }
    const data = await res.json();
    nicknames = data.nicknames || {};
    timezones = data.timezones || {};
    renderLevelHist(data.level_hist, data.level_hist_uids);
    renderDaysHist(data.days_hist, data.days_hist_uids);
    renderActivityHist(data.activity_hist, data.activity_hist_uids);
    renderDaily(data.daily, data.daily_uids);
  } catch (e) {
    msg.textContent = "Error: " + (e && e.message);
  }
}

// Hide the dashboard skeleton and explain why. Two cases: a uid that the worker
// rejected (403) names the device ID — a text node, so it can't inject HTML;
// no uid at all (private window, never opened the app) has none to report. Both
// point at the personal dashboard. `page` names the panel hit — this page and
// /stats/ share the wording bar that one word.
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
      + `<rect class="hitband" data-date="${d.k}" x="${bandX}%" y="0" width="${bandW}%" height="${y0}%"><title>${tip}</title></rect>`;
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
    // Lay a full-height band over each column (once) so clicking anywhere in it
    // — not just the thin bar — opens that bucket's uids, with a hover cue. The
    // bars are the static skeleton; bands go on top (appended last).
    const svg = col.querySelector("svg");
    if (!svg.querySelector(".hitband")) {
      svg.insertAdjacentHTML("beforeend", [0, 1, 2, 3, 4].map((i) =>
        `<rect class="hitband" data-bin="${i}" x="${10 + i * 44}" y="0" width="44" height="${baseY}"><title></title></rect>`).join(""));
    }
    for (let i = 0; i < 5; i++) {
      const bh = bins[i] / max * innerH;
      const rect = col.querySelector(`rect[data-bin="${i}"]:not(.hitband)`);
      rect.setAttribute("height", bh);
      rect.setAttribute("y", baseY - bh);
      const text = col.querySelector(`text.bincount[data-bin="${i}"]`);
      text.setAttribute("y", baseY - bh - 2);
      text.textContent = bins[i] || "";
      const band = col.querySelector(`rect.hitband[data-bin="${i}"]`);
      band.querySelector("title").textContent = `${i + 2} buttons: ${bins[i]} users`;
      band.onclick = () => showUidPopup(`${VOWEL_GYO[v]} · ${i + 2} buttons`, bucketUids[i]);
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
  const clickable = uids && titleFn;
  let html = "";
  for (let i = 0; i < n; i++) {
    const cx = padL + (i + 0.5) * bw;
    const bh = bins[i] / max * innerH;
    const title = `<title>${tooltipFn(i, bins[i])}</title>`;
    // When clickable, a full-height band over the whole column (below) is the
    // click/hover/tooltip target; otherwise the bar carries the tooltip itself.
    html += `<rect data-bin="${i}" x="${X(cx - barW / 2)}%" y="${Y(baseY - bh)}%" width="${X(barW)}%" height="${Y(bh)}%" fill="var(--accent)">${clickable ? "" : title}</rect>`;
    if (bins[i] > 0) {
      html += `<text x="${X(cx)}%" y="${Y(baseY - bh - 4)}%" fill="var(--muted)" font-size="11" text-anchor="middle">${bins[i]}</text>`;
    }
    if (labels[i]) {
      html += `<text x="${X(cx)}%" y="${Y(h - 6)}%" fill="var(--muted)" font-size="11" text-anchor="middle">${labels[i]}</text>`;
    }
    if (clickable) {
      html += `<rect class="hitband" data-bin="${i}" x="${X(padL + i * bw)}%" y="0" width="${X(bw)}%" height="${Y(baseY)}%">${title}</rect>`;
    }
  }
  svgEl.innerHTML = html;
  if (clickable) {
    // Delegate one click handler on the SVG. Each band carries data-bin so
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
})();
