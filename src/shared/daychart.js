// The daily-history bar chart, shared by the dashboard (activity + peak streak)
// and admin (activity) so the three day-charts are one component, not three
// hand-copied SVG builders. DOM-touching but frontend-only (the worker never
// imports this). Callers turn their source (events vs server rows) into a
// calendar-uniform `days` array via calendarSpan, then pass a `bar` callback.

import { pad2 } from "./dates.js";

// Calendar-uniform day buckets from firstKey to lastKey inclusive (both
// "YYYY-MM-DD"), each as { k, ...valueFor(k) }. Steps by calendar date via UTC
// arithmetic — the keys are plain dates, so this is timezone-agnostic: whichever
// zone the caller bucketed in (the viewer's local day for the per-user
// dashboard, the server's day for admin) is already baked into the endpoints.
// Callers pick the endpoints, so "extend the axis to today" is their choice.
export function calendarSpan(firstKey, lastKey, valueFor) {
  const days = [];
  const d = new Date(firstKey + "T00:00:00Z");
  const end = new Date(lastKey + "T00:00:00Z");
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    days.push({ k, ...valueFor(k) });
  }
  return days;
}

// "Nice" y-axis tick values up to `max` (0.5/1/2 × power-of-ten steps).
export function niceTicks(max) {
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const m = max / exp;
  const step = m < 2 ? 0.5 * exp : m < 5 ? 1 * exp : 2 * exp;
  const out = [];
  for (let t = step; t <= max; t += step) out.push(Math.round(t));
  return out;
}

// Day-bar chart into `el` (logical 960×h box; bottom 20 units are the label
// gutter). Bins cap at 18 units and right-anchor — newest day flush right, short
// ranges leave the left empty rather than smearing thinly, like the app's
// #topbar. `mag(d)` is the bar magnitude (drives the y-axis scale);
// `bar(d, x, barW, bh, y0)` returns the SVG for one day's bar(s) — its coords
// arrive as percentages (see below) to append "%" to; optional
// `annotate(max, X, Y)` adds a corner label; `grid` draws week/month date guides.
export function dayBarChart(el, days, h, mag, bar, annotate = () => "", grid = false) {
  const w = 960, innerH = h - 40, y0 = h - 20;
  const max = Math.max(1, ...days.map(mag));
  const binW = Math.min((w - 40) / Math.max(1, days.length), 18);
  const barW = Math.min(binW * 0.8, 14);
  const xRightmost = w - 20 - barW;
  // Geometry stays in the logical 960×h box, but every coordinate is emitted as
  // a percentage (no viewBox) so the SVG stretches to fill its container with
  // crisp, non-scaling px text. `bar`/`annotate` callbacks receive percentages
  // (numbers) and append "%". X spans the width, Y the height.
  const X = (v) => Math.round(v / w * 1e4) / 100, Y = (v) => Math.round(v / h * 1e4) / 100;
  let bars = "", labels = "", lastMonth = "", gridlines = "";
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const x = xRightmost - (days.length - 1 - i) * binW;
    // bandX/bandW give the full-width column lane (centred on the bar) so a
    // caller can lay a full-height click/hover target over the whole column,
    // not just the thin bar.
    if (mag(d) > 0) bars += bar(d, X(x), X(barW), Y(mag(d) / max * innerH), Y(y0), X(x - (binW - barW) / 2), X(binW));
    const month = d.k.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      labels += `<text x="${X(x)}%" y="${Y(h - 4)}%" fill="var(--muted)" font-size="10">${month}</text>`;
    }
  }
  // Week/month guides across the FULL plot width — not just where bars are. Walk
  // bin slots from the newest day leftward, extrapolating the calendar, so the
  // grid reads continuously even over the right-anchor's empty-left margin. (k is
  // YYYY-MM-DD; parse as UTC so getUTCDay/Date give the calendar weekday cleanly.)
  // Strokes are px (no viewBox scaling), so lines stay 1px at any size; --muted
  // dim for weeks, stronger for months (--panel-2 was ~invisible on the panel).
  if (grid && days.length) {
    const newest = new Date(days[days.length - 1].k + "T00:00:00Z");
    for (let j = 0; ; j++) {
      const lx = xRightmost - j * binW - (binW - barW) / 2;
      if (lx < 18) break;
      const sx = X(lx);
      const d = new Date(newest); d.setUTCDate(d.getUTCDate() - j);
      if (d.getUTCDate() === 1) {
        gridlines += `<line x1="${sx}%" x2="${sx}%" y1="0" y2="${Y(y0)}%" stroke="var(--muted)" stroke-width="1" stroke-opacity=".5"/>`;
      } else if (d.getUTCDay() === 1) {
        gridlines += `<line x1="${sx}%" x2="${sx}%" y1="0" y2="${Y(y0)}%" stroke="var(--muted)" stroke-width="1" stroke-opacity=".18"/>`;
      }
    }
  }
  let axis = "";
  for (const t of niceTicks(max)) {
    const y = y0 - t / max * innerH;
    axis += `<text x="0" y="${Y(y + 3)}%" fill="var(--muted)" font-size="10">${t}</text>`;
    axis += `<line x1="${X(20)}%" x2="100%" y1="${Y(y)}%" y2="${Y(y)}%" stroke="var(--panel-2)" stroke-width=".5"/>`;
  }
  el.innerHTML = `<svg>${axis}${gridlines}${bars}${labels}${annotate(max, X, Y)}</svg>`;
}

// Tooltip text for a day's activity: "YYYY-MM-DD  correct/total · NN%" (the %
// dropped when there were no answers). Shared by all three daily views.
export const dayTip = (k, correct, total) =>
  `${k}  ${correct}/${total}${total ? ` · ${Math.round(correct / total * 100)}%` : ""}`;
