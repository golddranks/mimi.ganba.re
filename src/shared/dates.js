// Local-time date helpers, shared by the app and the dashboard. The per-day
// stats buckets are keyed by YYYY-MM-DD in the viewer's own timezone.
export const pad2 = (x) => ("0" + x).slice(-2);

// A Date → its YYYY-MM-DD bucket key.
export const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// Epoch-ms → bucket key (dashboard renders server events keyed by ts).
export const dayKey = (ts) => dateKey(new Date(ts));

// Epoch-ms → bucket key in a *fixed* tz given as minutes east of UTC, independent
// of the runner's own timezone. Shift the instant by the offset, then read its UTC
// calendar date. The dashboard passes the viewed user's stored tz_offset so a day
// (and its done/not-done meaning) is bucketed in that user's local frame, not the
// viewer's. Format matches dateKey (YYYY-MM-DD), so calendarSpan consumes it too.
export const dayKeyTz = (ts, tzMin) => new Date(ts + tzMin * 60000).toISOString().slice(0, 10);

// n days ago from now → bucket key (n=0 is today).
export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateKey(d);
}
