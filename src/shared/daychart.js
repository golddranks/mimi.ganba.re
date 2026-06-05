// The daily-history bar chart, shared by the dashboard (activity + peak streak)
// and admin (activity) so the three day-charts are one component, not three
// hand-copied SVG builders. DOM-touching but frontend-only (the worker never
// imports this). Each caller builds its own calendar-uniform `days` array (the
// source differs: events vs server rows) and passes a `bar` callback.

// "Nice" y-axis tick values up to `max` (0.5/1/2 × power-of-ten steps).
export function niceTicks(max) {
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const m = max / exp;
  const step = m < 2 ? 0.5 * exp : m < 5 ? 1 * exp : 2 * exp;
  const out = [];
  for (let t = step; t <= max; t += step) out.push(Math.round(t));
  return out;
}

// Day-bar chart into `el` (fixed 960×h viewBox; bottom 20 units are the label
// gutter). Bins cap at 18 viewBox units and right-anchor — newest day flush
// right, short ranges leave the left empty rather than smearing thinly, like
// the app's #topbar. `mag(d)` is the bar magnitude (drives the y-axis scale);
// `bar(d, x, barW, bh, y0)` returns the SVG for one day's bar(s); optional
// `annotate(max)` adds a corner label; `grid` draws week/month date guides.
export function dayBarChart(el, days, h, mag, bar, annotate = () => "", grid = false) {
  const w = 960, innerH = h - 40, y0 = h - 20;
  const max = Math.max(1, ...days.map(mag));
  const binW = Math.min((w - 40) / Math.max(1, days.length), 18);
  const barW = Math.min(binW * 0.8, 14);
  const xRightmost = w - 20 - barW;
  let bars = "", labels = "", lastMonth = "", gridlines = "";
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const x = xRightmost - (days.length - 1 - i) * binW;
    if (mag(d) > 0) bars += bar(d, x, barW, mag(d) / max * innerH, y0);
    const month = d.k.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      labels += `<text x="${x}" y="${h - 4}" fill="var(--muted)" font-size="10">${month}</text>`;
    }
    // Date-axis guides at the bin's leading edge, behind the bars: a dim line
    // each Monday, a stronger one at the first of the month. new Date(k) parses
    // YYYY-MM-DD as UTC, so getUTCDay() gives the calendar weekday cleanly.
    if (grid) {
      const lx = (x - (binW - barW) / 2).toFixed(1);
      // non-scaling-stroke → crisp 1px regardless of the chart's render width
      // (these charts range from full-width to half-column). --muted, dim for
      // weeks and stronger for months; --panel-2 was ~invisible on the panel.
      if (d.k.slice(-2) === "01") {
        gridlines += `<line x1="${lx}" x2="${lx}" y1="0" y2="${y0}" stroke="var(--muted)" stroke-width="1" stroke-opacity=".5" vector-effect="non-scaling-stroke"/>`;
      } else if (new Date(d.k).getUTCDay() === 1) {
        gridlines += `<line x1="${lx}" x2="${lx}" y1="0" y2="${y0}" stroke="var(--muted)" stroke-width="1" stroke-opacity=".18" vector-effect="non-scaling-stroke"/>`;
      }
    }
  }
  let axis = "";
  for (const t of niceTicks(max)) {
    const y = y0 - t / max * innerH;
    axis += `<text x="0" y="${y + 3}" fill="var(--muted)" font-size="10">${t}</text>`;
    axis += `<line x1="20" x2="${w}" y1="${y}" y2="${y}" stroke="var(--panel-2)" stroke-width=".5"/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${axis}${gridlines}${bars}${labels}${annotate(max)}</svg>`;
}
