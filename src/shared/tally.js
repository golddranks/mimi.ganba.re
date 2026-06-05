// The per-heard-sound tally the confusion targets (shared/confusion.js) are
// computed from. Shape per sound:
//   { n, correct, conf: {picked: count}, offered: {sibling: count} }
// conf = wrong picks (only counted when the offered set was known); offered =
// how often each distractor was on screen. conf[C] <= offered[C], so they form
// the k/n a confusion case needs. Lifetime counts, not a recency window.
//
// Two producers must agree on this shape: the app builds it incrementally as you
// answer (grind.js, opts in hand as an array), and the dashboard rebuilds it from
// stored events (opts as a comma-string). They share this module so they can't
// drift — a divergence would make the dashboard's drift check compare against a
// tally the app would never have produced.

// Fold one answer into a tally (mutates `tally`). `opts` is the array of kana
// that were on screen; pass [] when the offered set is unknown — a wrong pick we
// can't attribute to a known confuser isn't a usable confusion (the picked and
// offered counts a case needs must come from the same answers).
export function bump(tally, target, picked, opts = []) {
  const t = (tally[target] ||= { n: 0, correct: 0, conf: {}, offered: {} });
  t.n++;
  t.conf ||= {}; t.offered ||= {};   // guard entries saved before these existed
  if (picked === target) t.correct++;
  else if (opts.length) t.conf[picked] = (t.conf[picked] || 0) + 1;
  for (const o of opts) if (o !== target) t.offered[o] = (t.offered[o] || 0) + 1;
}

// Build a fresh tally from an answer-event array (the dashboard/server shape,
// where `opts` is a comma-joined string). `isAnswer` decides which events count.
export function tallyFromEvents(events, isAnswer) {
  const tally = {};
  for (const e of events) {
    if (!isAnswer(e)) continue;
    bump(tally, e.target, e.picked, e.opts ? e.opts.split(",") : []);
  }
  return tally;
}

// Build the shown[T/P] (wrong picks) and offered[T/P] (offers) maps the target
// classifier expects from a tally. The diagonal (T/T) is never present — bump
// records correct picks only as `correct`, never in conf/offered.
export function tallyMaps(tally) {
  const shown = {}, offered = {};
  for (const target of Object.keys(tally)) {
    const { conf = {}, offered: off = {} } = tally[target];
    for (const c of Object.keys(conf)) shown[`${target}/${c}`] = conf[c];
    for (const o of Object.keys(off)) offered[`${target}/${o}`] = off[o];
  }
  return { shown, offered };
}
