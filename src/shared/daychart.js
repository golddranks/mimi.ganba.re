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

// Day-bar chart into `el`. Every day is rendered at a FIXED physical pitch into a
// plot SVG that gets a real pixel width and sits right-anchored inside an
// overflow-hidden clipper — so the container's width (any width, live through
// resizes/rotation, no JS measurement) simply decides how many recent days are
// visible. Newest day flush right; short ranges leave the left empty rather than
// smearing. The y-axis tick labels live in a separate SVG pinned left of the
// clipper, since they must not clip away with the old days. Vertically everything
// is still %-of-h (the logical height; bottom 20 units are the label gutter), so
// the bars stretch to whatever height the container gives.
// `mag(d)` is the bar magnitude (drives the y-axis scale); `bar(d, x, barW, bh,
// y0, bandX, bandW)` returns the SVG for one day's bar(s) — its coords arrive as
// percentages (numbers) to append "%" to; optional `annotate(max, X, Y, w)` adds
// a corner label; `grid` draws week/month date guides.
export function dayBarChart(el, days, h, mag, bar, annotate = () => "", grid = false) {
  const binW = 18, barW = 14;          // px per day / bar — constant on every screen
  const innerH = h - 40, y0 = h - 20;
  const w = days.length * binW + 40;   // the plot SVG's real pixel width
  const max = Math.max(1, ...days.map(mag));
  const xRightmost = w - 20 - barW;
  // X/Y emit percentages of the plot SVG's box. The box's width is w real pixels,
  // so X percentages are fixed pixel positions in disguise — the callbacks keep
  // their existing "append %" contract — while Y stays container-relative.
  const X = (v) => Math.round(v / w * 1e4) / 100, Y = (v) => Math.round(v / h * 1e4) / 100;
  let bars = "", labels = "", lastMonth = "", gridlines = "", lastLabelX = -Infinity;
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
      // Labels are ~52px wide (fixed-px text); skip one that would collide with
      // its predecessor rather than overlapping.
      if (x - lastLabelX >= 52) {
        labels += `<text x="${X(x)}%" y="${Y(h - 4)}%" fill="var(--muted)" font-size="10">${month}</text>`;
        lastLabelX = x;
      }
    }
  }
  // Week/month guides across the FULL plot width — not just where bars are. Walk
  // bin slots from the newest day leftward, extrapolating the calendar, so the
  // grid reads continuously even over the right-anchor's empty-left margin. (k is
  // YYYY-MM-DD; parse as UTC so getUTCDay/Date give the calendar weekday cleanly.)
  // Strokes are px, --muted dim for weeks, stronger for months (--panel-2 was
  // ~invisible on the panel).
  if (grid && days.length) {
    const newest = new Date(days[days.length - 1].k + "T00:00:00Z");
    for (let j = 0; ; j++) {
      const lx = xRightmost - j * binW - (binW - barW) / 2;
      if (lx < 0) break;
      const sx = X(lx);
      const d = new Date(newest); d.setUTCDate(d.getUTCDate() - j);
      if (d.getUTCDate() === 1) {
        gridlines += `<line x1="${sx}%" x2="${sx}%" y1="0" y2="${Y(y0)}%" stroke="var(--muted)" stroke-width="1" stroke-opacity=".5"/>`;
      } else if (d.getUTCDay() === 1) {
        gridlines += `<line x1="${sx}%" x2="${sx}%" y1="0" y2="${Y(y0)}%" stroke="var(--muted)" stroke-width="1" stroke-opacity=".18"/>`;
      }
    }
  }
  let tickLines = "", tickText = "";
  for (const t of niceTicks(max)) {
    const y = y0 - t / max * innerH;
    tickText += `<text x="0" y="${Y(y + 3)}%" fill="var(--muted)" font-size="10">${t}</text>`;
    tickLines += `<line x1="0" x2="100%" y1="${Y(y)}%" y2="${Y(y)}%" stroke="var(--panel-2)" stroke-width=".5"/>`;
  }
  // Styles are inline so the component carries its own layout to every page (the
  // pages' generic `.card svg { width:100% }` rules are overridden). The clipper
  // starts right of the 26px tick-label rail, so bars never run under the labels.
  el.style.position = "relative";
  el.innerHTML =
    `<div style="position:absolute;inset:0 0 0 26px;overflow:hidden">`
    + `<svg style="position:absolute;top:0;right:0;height:100%;width:${w}px">${tickLines}${gridlines}${bars}${labels}${annotate(max, X, Y, w)}</svg>`
    + `</div>`
    + `<svg style="position:absolute;left:0;top:0;width:26px;height:100%;overflow:visible">${tickText}</svg>`;
}

// Tooltip text for a day's activity: "YYYY-MM-DD  correct/total · NN%" (the %
// dropped when there were no answers). Shared by all three daily views.
export const dayTip = (k, correct, total) =>
  `${k}  ${correct}/${total}${total ? ` · ${Math.round(correct / total * 100)}%` : ""}`;
