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

// Per-(target/kana) counts for the confusion matrix's alternate metrics. Each
// shares the *same* `offered` denominator (confusionMaps) as the main picked map:
//   guessed     — a guess answer (ev 'g') picked that kana. picked === target is a
//                 *correct* guess → the diagonal, so it's its own axis, not a
//                 subset of "wrong".
//   afterPlayed — that kana was tapped to replay during review (ev 'p', picked = it).
//   reListened  — the question had a re-listen (ev 'r'). A re-listen is about the
//                 sound, not a pick, so it's counted against EVERY kana the question
//                 offered. A re-listen always *precedes* its answer in time, so it's
//                 grouped by order: walk in ts order and let the next answer of that
//                 sound consume it. (NOT by (target, ts - ms): the app stamps ts and
//                 ms from separate clock reads, so they're a few ms apart and never
//                 match exactly — which silently dropped every re-listen.)
// "Slow reaction": an answer among the slowest of THIS user's *engaged* reactions —
// under 6s, since beyond that they'd stepped away, not hesitated — at/above their
// 96th percentile (slowest ~4%). Per-user, so a fast and a slow user each judge
// against their own pace. Counted per pick like wrong: a slow *correct* answer is
// still hesitation, so it lands on the diagonal too.
const SLOW_CAP_MS = 6000;
const SLOW_PCTL = 0.96;
function nearestRankPctile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

export function confusionExtras(events) {
  const guessed = {}, afterPlayed = {}, reListened = {}, slow = {};
  const bump1 = (m, t, p) => { m[`${t}/${p}`] = (m[`${t}/${p}`] || 0) + 1; };
  const answers = [], engaged = [];   // for the slow-reaction percentile
  let relistenedTarget = null;        // a re-listen waiting for its answer (by ts order)
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const rec = confusionRecord(e);   // non-null for a/g/y/n
    if (rec) {
      if (e.ev === "g") bump1(guessed, rec.target, rec.picked);
      if (typeof e.ms === "number") {
        answers.push({ t: rec.target, p: rec.picked, ms: e.ms });
        if (e.ms < SLOW_CAP_MS) engaged.push(e.ms);
      }
      // this answer ends the question; if it re-listened, credit every offered kana
      if (relistenedTarget === rec.target) for (const p of rec.opts) bump1(reListened, rec.target, p);
      relistenedTarget = null;
    } else if (e.ev === "r") relistenedTarget = e.target;
    else if (e.ev === "p") bump1(afterPlayed, e.target, e.picked);
  }
  const p96 = nearestRankPctile(engaged, SLOW_PCTL);
  if (p96 != null) for (const a of answers) if (a.ms >= p96 && a.ms < SLOW_CAP_MS) bump1(slow, a.t, a.p);
  return { guessed, afterPlayed, reListened, slow };
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

// The confusion matrix the dashboard *renders* — tallyMaps plus the diagonal:
// shown[T/T] = correct picks, offered[T/T] = total answers for T (T is always
// offered, so it's the per-sound denominator). Built on tallyMaps, so its
// off-diagonal is the drift check's basis by construction — the dashboard's
// matrix and the grind tally are one projection of one tally, never two that can
// disagree (that divergence was the permanent-"out of sync" bug).
export function confusionMaps(tally) {
  const { shown, offered } = tallyMaps(tally);
  for (const target of Object.keys(tally)) {
    shown[`${target}/${target}`] = tally[target].correct || 0;
    offered[`${target}/${target}`] = tally[target].n || 0;
  }
  return { shown, offered };
}
