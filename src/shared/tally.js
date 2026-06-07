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
// offered counts a case needs must come from the same answers). A wrong pick is
// recorded as a confusion only when it's one of the offered kana — so a synthetic
// "missed it, no confuser" pick (Y/N's empty `picked`, never in `opts`) lands as
// a plain miss (n up, correct flat) without inventing a phantom confuser.
export function bump(tally, target, picked, opts = []) {
  const t = (tally[target] ||= { n: 0, correct: 0, conf: {}, offered: {} });
  t.n++;
  t.conf ||= {}; t.offered ||= {};   // guard entries saved before these existed
  if (picked === target) t.correct++;
  else if (opts.includes(picked)) t.conf[picked] = (t.conf[picked] || 0) + 1;
  for (const o of opts) if (o !== target) t.offered[o] = (t.offered[o] || 0) + 1;
}

// Normalise an event into the confusion shape { target, picked, opts:[…] }, or
// null if it carries no usable confusion data. Multi-choice answers (a/g) already
// know their offered set. Y/N answers (y/n) don't, so we synthesise one: the
// sound asked is `target`, its own kana is always offered (the diagonal), and a
// wrong-kana prompt also offers the confuser (the displayed kana, stored as
// `picked`). A correct judgement counts as picking the target (a diagonal hit); a
// wrong one as picking the confuser (wrong-kana prompt) or nothing (failing to
// recognise the correct kana → a diagonal miss, `picked` empty). This is the one
// place Y/N is mapped onto the matrix, so the dashboard, the cell-history strip,
// and the grind tally all agree.
export function confusionRecord(e) {
  if (e.ev === "a" || e.ev === "g") {
    return e.opts ? { target: e.target, picked: e.picked, opts: e.opts.split(",") } : null;
  }
  if (e.ev === "y" || e.ev === "n") {
    const wrongKana = e.picked !== e.target;          // picked = the kana shown
    const correct = (e.ev === "y") ? !wrongKana : wrongKana;
    return {
      target: e.target,
      picked: correct ? e.target : (wrongKana ? e.picked : ""),
      opts: wrongKana ? [e.target, e.picked] : [e.target],
    };
  }
  return null;
}

// Build a fresh tally from an answer-event array (the dashboard/server shape,
// where `opts` is a comma-joined string). confusionRecord decides which events
// count and normalises Y/N, so the rebuilt tally matches what the app records
// live (it feeds bump the same normalised picks).
export function tallyFromEvents(events) {
  const tally = {};
  for (const e of events) {
    const r = confusionRecord(e);
    if (r) bump(tally, r.target, r.picked, r.opts);
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
