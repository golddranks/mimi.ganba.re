// Frontend chart/control helpers shared by the per-user dashboard and the admin
// dashboard, so the per-sound bars, hour-of-day chart and count/pct toggles are
// one component each rather than hand-copied per page. DOM-touching but
// frontend-only (the worker never imports this). Callers normalise their own
// data shape (events vs server aggregates) into the {correct, total} forms here.

import { pad2 } from "./dates.js";

// Per-sound horizontal bars. `container` holds the static `.mrow` elements (each
// with a data-mora key, an .mbar-total / .mbar-correct pair, and an .mtxt
// readout). `counts` maps key → {correct, total}; `maxN` is the largest total
// (for volume scaling in count mode). Rows are reordered hardest-first — lowest
// accuracy among attempted sounds, unattempted sinking to the bottom. The
// count·% readout shows in BOTH modes; the mode only changes the bar scaling
// (count = bar length ∝ volume, pct = equal-width bars so accuracy compares).
export function drawBars(container, counts, maxN, mode) {
  const at = (row) => counts[row.dataset.mora] || { correct: 0, total: 0 };
  const rows = [...container.querySelectorAll(".mrow")];
  rows.sort((a, b) => {
    const ca = at(a), cb = at(b);
    if (!ca.total && !cb.total) return 0;
    if (!ca.total) return 1;
    if (!cb.total) return -1;
    return ca.correct / ca.total - cb.correct / cb.total;
  });
  for (const row of rows) {
    container.appendChild(row);   // reorder in place
    const c = at(row);
    const acc = c.total ? c.correct / c.total : 0;
    row.querySelector(".mbar-total").style.width =
      (mode === "pct" ? (c.total ? 100 : 0) : c.total / maxN * 100) + "%";
    row.querySelector(".mbar-correct").style.width = acc * 100 + "%";
    row.querySelector(".mtxt").textContent =
      c.total ? `${c.correct}/${c.total} · ${Math.round(acc * 100)}%` : "0/0";
  }
}

// Hour-of-day stacked bars (correct over wrong) into `el`. `hrs` is a 24-element
// array of {correct, total}. `tipSuffix` is appended to the hour in tooltips
// (e.g. " UTC" for the cross-user admin view). Authored viewBox-less with %
// geometry so it stretches to fill its container with crisp px text.
export function drawHourly(el, hrs, tipSuffix = "") {
  const max = Math.max(1, ...hrs.map((h) => h.total));
  const w = 480, h = 180, innerH = h - 40, bw = (w - 40) / 24;
  const X = (v) => (v / w * 100).toFixed(2), Y = (v) => (v / h * 100).toFixed(2);
  let bars = "", labels = "";
  for (let i = 0; i < 24; i++) {
    const { correct, total } = hrs[i];
    const totH = total / max * innerH;
    const cH = total ? correct / total * totH : 0;
    const x = 20 + i * bw;
    const tip = `${pad2(i)}:00${tipSuffix}  ${correct}/${total}`;
    if (total) {
      bars += `<rect x="${X(x)}%" y="${Y(h - 20 - totH)}%" width="${X(bw * 0.8)}%" height="${Y(totH)}%" fill="var(--bad-bar)"><title>${tip}</title></rect>`;
      bars += `<rect x="${X(x)}%" y="${Y(h - 20 - cH)}%" width="${X(bw * 0.8)}%" height="${Y(cH)}%" fill="var(--good)"><title>${tip}</title></rect>`;
    }
    if (i % 3 === 0) {
      labels += `<text x="${X(x + bw * 0.4)}%" y="${Y(h - 4)}%" fill="var(--muted)" font-size="10" text-anchor="middle">${i}</text>`;
    }
  }
  el.innerHTML = `<svg>${bars}${labels}</svg>`;
}

// Wire a group of segmented toggles that share one selected value. On a click of
// any `button[data-${attr}]` within `switches`, the active class is synced across
// every button in the group and `onPick(value)` runs. Used for the count/pct
// switches (one logical group spanning several .modeswitch elements) and the
// confusion denominator switch (a group of one).
export function wireSwitchGroup(switches, attr, onPick) {
  const els = [...switches];
  for (const sw of els) {
    sw.addEventListener("click", (e) => {
      const btn = e.target.closest(`button[data-${attr}]`);
      if (!btn) return;
      const val = btn.dataset[attr];
      for (const s of els) {
        for (const b of s.querySelectorAll(`button[data-${attr}]`)) {
          b.classList.toggle("active", b.dataset[attr] === val);
        }
      }
      onPick(val);
    });
  }
}
