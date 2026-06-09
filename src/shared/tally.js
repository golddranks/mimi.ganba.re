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

// Per-(target/kana) counts for the confusion matrix's alternate metrics.
//   guessed     — a guess answer (ev 'g') picked that kana. picked === target is a
//                 *correct* guess → the diagonal, so it's its own axis, not a
//                 subset of "wrong". Over the shared `offered` denominator.
//   afterPlayed — that kana was tapped to replay during review (ev 'p', picked = it).
//                 Over the shared `offered` denominator.
//   reListened  — the question had a re-listen (ev 'r'); counted against EVERY kana
//                 the question offered (a re-listen is about the sound, not a pick).
//                 Question-scoped by start_ts, so multiple re-listens of one question
//                 count once and a never-answered question still counts. Its own
//                 denominator, reListenedOffered (every question that offered the kana,
//                 answered or not), because you can re-listen without ever answering —
//                 unlike "wrong", which only makes sense on an answered question.
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
  const guessed = {}, afterPlayed = {}, reListened = {}, reListenedOffered = {}, slow = {};
  const bump1 = (m, t, p) => { m[`${t}/${p}`] = (m[`${t}/${p}`] || 0) + 1; };
  const answers = [], engaged = [];   // for the slow-reaction percentile
  // Re-listen is a property of the *question*, not one event: a question can be
  // re-listened several times and may never be answered. Every event that had the
  // choices on screen now carries `opts` (a/g and, going forward, r/p too), so we
  // group by start_ts (the per-question key) and read the offered set off whichever
  // event recorded it. reListenedOffered is the re-listen denominator: every
  // question that offered P, answered or not — so an abandoned-but-re-listened
  // question still counts, unlike the wrong/guessed `offered` which (rightly) counts
  // only answered questions. Rows without start_ts (pre-migration) carry no opts on
  // r/p, so their re-listens don't enter this metric.
  const questions = new Map();        // start_ts -> { target, opts:[…]|null, relistened }
  for (const e of events) {
    const rec = confusionRecord(e);   // non-null for a/g/y/n
    if (rec) {
      if (e.ev === "g") bump1(guessed, rec.target, rec.picked);
      if (typeof e.ms === "number") {
        answers.push({ t: rec.target, p: rec.picked, ms: e.ms });
        if (e.ms < SLOW_CAP_MS) engaged.push(e.ms);
      }
    } else if (e.ev === "p") bump1(afterPlayed, e.target, e.picked);
    if (e.start_ts != null) {
      const q = questions.get(e.start_ts) || { target: e.target, opts: null, relistened: false };
      if (e.opts) q.opts = e.opts.split(",");
      if (e.ev === "r") q.relistened = true;
      questions.set(e.start_ts, q);
    }
  }
  for (const q of questions.values()) {
    if (!q.opts) continue;            // unknown offered set (Y/N, or a re-listen-only legacy question)
    for (const p of q.opts) {
      bump1(reListenedOffered, q.target, p);
      if (q.relistened) bump1(reListened, q.target, p);
    }
  }
  const p96 = nearestRankPctile(engaged, SLOW_PCTL);
  if (p96 != null) for (const a of answers) if (a.ms >= p96 && a.ms < SLOW_CAP_MS) bump1(slow, a.t, a.p);
  return { guessed, afterPlayed, reListened, reListenedOffered, slow };
}

// Per-recording (target, voice) versions of every confusion metric — the
// sound-file matrix's counterpart of confusionExtras + confusionMaps, each map
// keyed `target/voice/kana`. `answered`/`offered` come straight from a/g answers
// (so they cover pre-start_ts rows the way the matrix always has). The rest need
// the per-question key: a re-listen is counted once per question, and an after-play
// must attribute to the QUESTION's recording — its own `voice` is the *tapped*
// kana's — so the recording comes from the start_ts group (any a/g/r event of it).
// relistenedOffered is the re-listen denominator (every question that offered the
// kana, answered or not); the others normalise by `offered`.
export function confusionExtrasByVoice(events) {
  const answered = {}, guessed = {}, relistened = {}, afterplayed = {}, slow = {}, offered = {}, relistenedOffered = {};
  const bump = (m, t, v, p) => { const k = `${t}/${v}/${p}`; m[k] = (m[k] || 0) + 1; };
  const reactions = [], engaged = [];   // for the slow-reaction percentile (same as confusionExtras, per recording)
  for (const e of events) {
    if ((e.ev !== "a" && e.ev !== "g") || !e.voice) continue;
    const r = confusionRecord(e);
    if (!r) continue;
    bump(answered, r.target, e.voice, r.picked);
    if (e.ev === "g") bump(guessed, r.target, e.voice, r.picked);
    for (const k of r.opts) bump(offered, r.target, e.voice, k);
    if (typeof e.ms === "number") {
      reactions.push({ t: r.target, v: e.voice, p: r.picked, ms: e.ms });
      if (e.ms < SLOW_CAP_MS) engaged.push(e.ms);
    }
  }
  const p96 = nearestRankPctile(engaged, SLOW_PCTL);
  if (p96 != null) for (const a of reactions) if (a.ms >= p96 && a.ms < SLOW_CAP_MS) bump(slow, a.t, a.v, a.p);
  // Per-question pass: the question's recording (voice) carries the re-listen and
  // every after-play of that question, regardless of which kana was tapped.
  const Q = new Map();   // start_ts -> { target, voice, opts, relistened, plays:[…] }
  for (const e of events) {
    if (e.start_ts == null) continue;
    const q = Q.get(e.start_ts) || { target: e.target, voice: null, opts: null, relistened: false, plays: [] };
    if ((e.ev === "a" || e.ev === "g" || e.ev === "r") && e.voice) q.voice = e.voice;
    if (e.opts) q.opts = e.opts.split(",");
    if (e.ev === "r") q.relistened = true;
    if (e.ev === "p") q.plays.push(e.picked);
    Q.set(e.start_ts, q);
  }
  for (const q of Q.values()) {
    if (!q.voice) continue;
    for (const p of q.plays) bump(afterplayed, q.target, q.voice, p);
    if (!q.opts) continue;
    for (const k of q.opts) {
      bump(relistenedOffered, q.target, q.voice, k);
      if (q.relistened) bump(relistened, q.target, q.voice, k);
    }
  }
  return { answered, guessed, relistened, afterplayed, slow, offered, relistenedOffered };
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
