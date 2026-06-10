// Grind/probe target classification for confusion-matrix cells, computed from
// the pick-when-offered data: each off-diagonal case (target T, picked P) has
// k = wrong picks (P chosen when T was asked and P offered) of n = offers.
//
// The wrong-rate posterior is p ~ Beta(1+k, 4+(n-k)) under a Beta(1,4) prior.
// The threshold probability is exact via the Beta-binomial identity — no
// numerics needed:
//     P(p > 0.2) = P(Binomial(n+4, 0.2) <= k)
// i.e. the binomial CDF at k, summed directly (terms built iteratively so big
// binomial coefficients never overflow).
export function pAbove20(k, n) {
  const N = n + 4, p = 0.2;
  let term = Math.pow(1 - p, N);   // j = 0
  let cdf = term;
  for (let j = 1; j <= k; j++) {
    term *= ((N - j + 1) / j) * (p / (1 - p));
    cdf += term;
  }
  return Math.min(cdf, 1);
}

// Fit P(y=1) = sigmoid(b0 + b1*x) to a chronological 0/1 sequence, with x the
// position normalised to [0,1]. Used by the dashboard cell-history view to show
// whether a confusion is trending up or down over time. Ridge-regularised
// gradient descent so perfectly-separable runs converge to a finite, gentle
// slope instead of diverging. Returns { b0, b1 } (or null for < 2 points).
export function logisticFit(ys) {
  const n = ys.length;
  if (n < 2) return null;
  let b0 = 0, b1 = 0;
  const lr = 0.5, lambda = 2e-3, iters = 800;
  for (let it = 0; it < iters; it++) {
    let g0 = 0, g1 = 0;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      const p = 1 / (1 + Math.exp(-(b0 + b1 * x)));
      const d = p - ys[i];
      g0 += d; g1 += d * x;
    }
    b0 -= lr * (g0 / n + lambda * b0);
    b1 -= lr * (g1 / n + lambda * b1);
  }
  return { b0, b1 };
}

// Probability the fitted line predicts at normalised position x in [0,1].
export const logisticAt = (fit, x) => 1 / (1 + Math.exp(-(fit.b0 + fit.b1 * x)));

// Whether a 0/1 sequence shows a *statistically real* trend, so we don't claim
// "improving/worsening" off a handful of noisy points. Likelihood-ratio test of
// the fitted line vs an intercept-only (flat) model: LR ~ chi-square(1), so
// LR >= 3.84 is p < 0.05. (e.g. 8 noisy points → not significant; a clean run or
// a large consistent drift → significant.) Returns { significant, improving, fit }.
export function logisticTrend(ys) {
  const n = ys.length;
  if (n < 5) return { significant: false };
  const fit = logisticFit(ys);
  const clamp = (p) => Math.min(1 - 1e-9, Math.max(1e-9, p));
  let llFull = 0;
  for (let i = 0; i < n; i++) {
    const p = clamp(logisticAt(fit, i / (n - 1)));
    llFull += ys[i] * Math.log(p) + (1 - ys[i]) * Math.log(1 - p);
  }
  const m = clamp(ys.reduce((a, b) => a + b, 0) / n);
  const llNull = n * (m * Math.log(m) + (1 - m) * Math.log(1 - m));
  const lr = 2 * (llFull - llNull);
  return { significant: lr >= 3.84, improving: logisticAt(fit, 1) < logisticAt(fit, 0), fit };
}

// Classify the off-diagonal cases from shown[`T/P`] (wrong picks) and
// offered[`T/P`] (offers). Returns:
//   grind     — Set of "T/P" we're >95% sure exceed a 20% wrong-rate (drill these)
//   bestGrind — the grind case with the highest observed wrong-rate, or null
//   probes    — Set of all still-uncertain "T/P" (neither confidently above nor
//               below 20%); the dashboard rings every one of these
//   probe     — the single uncertain case with the highest wrong-rate (the one
//               grind mode probes next), or null. Recompute when the data changes.
export function confusionTargets(shown, offered) {
  const grind = new Set();
  const probes = new Set();
  let probe = null, probeRate = -1, probeN = -1;
  let bestGrind = null, grindRate = -1, grindN = -1;
  for (const key of Object.keys(offered)) {
    const [t, p] = key.split("/");
    if (t === p) continue;            // diagonal = correct answers, not a case
    const n = offered[key];
    if (!n) continue;
    const k = shown[key] || 0;
    const rate = k / n;
    const pa = pAbove20(k, n);
    if (pa > 0.95) {                  // confidently > 20% → grind
      grind.add(key);
      if (rate > grindRate || (rate === grindRate && n > grindN)) {
        bestGrind = key; grindRate = rate; grindN = n;
      }
      continue;
    }
    if (pa < 0.05) continue;          // confidently < 20% → ignore
    probes.add(key);                  // uncertain
    if (rate > probeRate || (rate === probeRate && n > probeN)) {
      probe = key; probeRate = rate; probeN = n;
    }
  }
  return { grind, bestGrind, probes, probe };
}

// ---------- consonant grouping ----------
// A *phonetic* (Hepburn) grouping, NOT the kunrei spelling the data uses: し/しゃ…
// are stored as si/sya etc. but sound "sh"; ち→ch, つ→ts. So the plain s/z/t rows
// split by sound. CONSONANT_ORDER is the consonant matrix's row/column order;
// together these partition all 19 morae with none left over.
export const CONSONANT_ORDER = ["s", "z", "ts", "sh", "j", "ch"];
export const CONSONANT_GROUPS = {
  s:  ["sa", "su", "so"],
  z:  ["za", "zu", "zo"],
  ts: ["tu"],
  sh: ["si", "sya", "syu", "syo"],
  j:  ["zi", "zya", "zyu", "zyo"],
  ch: ["ti", "tya", "tyu", "tyo"],
};
const MORA_CONSONANT = Object.fromEntries(
  Object.entries(CONSONANT_GROUPS).flatMap(([c, ms]) => ms.map((m) => [m, c])),
);
export const consonantOf = (mora) => MORA_CONSONANT[mora];

// Collapse a per-mora accuracy map { mora: {correct, total} } to a per-consonant
// one { cons: {correct, total} }, summing each consonant's morae. Feeds the
// "By consonant" bar list (drawBars), the consonant-level twin of per-sound.
export function consonantCounts(moraCounts) {
  const out = {};
  for (const m in moraCounts) {
    const c = consonantOf(m);
    if (!c) continue;
    const o = out[c] || (out[c] = { correct: 0, total: 0 });
    o.correct += moraCounts[m].correct;
    o.total += moraCounts[m].total;
  }
  return out;
}

// Collapse mora-keyed confusion maps to consonant-keyed ones, summing over every
// vowel. Option sets are always same-vowel, so shown[t/p]/offered[t/p] are
// non-zero only for same-vowel pairs; summing every t∈cT, p∈cP therefore gives
// exactly the consonant-vs-consonant totals. `maps` and the result share the
// shape { shown:T/P→n, offered:T/P→n }.
export function aggregateByConsonant(maps) {
  const out = { shown: {}, offered: {} };
  const addPair = (dst, key, v) => {
    const [t, p] = key.split("/");
    const ct = consonantOf(t), cp = consonantOf(p);
    if (ct && cp) dst[`${ct}/${cp}`] = (dst[`${ct}/${cp}`] || 0) + v;
  };
  for (const k in maps.shown) addPair(out.shown, k, maps.shown[k]);
  for (const k in maps.offered) addPair(out.offered, k, maps.offered[k]);
  return out;
}

// ---------- confusion-cell rendering ----------
// Shared by the per-vowel and consonant matrices in both the dashboard and admin
// so all four read identically. One cell's { display, mag, raw }: mag drives the
// colour, display is the text, raw>0 means "has data". `maps` = { shown, offered }
// (a pick normalised by how often that kana was offered); `mode` = "pct"|"count".
export function confusionValue(maps, t, p, mode) {
  const n = maps.shown[`${t}/${p}`] || 0;
  const off = maps.offered[`${t}/${p}`] || 0;
  // Colour by the pick-when-offered rate in both displays, so a cell reads the
  // same whether it shows "3/4" or "75%" — they're the same quantity.
  const pct = off > 0 ? n / off * 100 : 0;
  if (mode === "pct") {
    let display = "";
    if (off > 0 && n > 0) { const r = Math.round(pct); display = r === 0 ? "<1" : String(r); }
    return { display, mag: pct, raw: off };
  }
  return { display: off ? `${n}/${off}` : "", mag: pct, raw: off };
}

// Cell background for a magnitude, normalised within its category (diagonal vs
// off-diagonal) so off-diagonal errors aren't drowned out by big correct counts.
// `scheme` "outcome" colours by correctness — diagonal green (--good), off-diagonal
// red (--bad), reading as right/wrong (answered, guessed, slow). "neutral" uses one
// accent hue for both: re-listened / after-played have no wrong axis (a re-listen is
// counted on every offered kana; an after-play just replays a choice), so red/green
// would imply a "wrong" that isn't there. Only the hue changes; intensity is the same.
export function confusionBg(mag, diag, maxOn, maxOff, scheme = "outcome") {
  if (!(mag > 0)) return "transparent";
  const base = scheme === "neutral" ? "var(--accent)" : (diag ? "var(--good)" : "var(--bad)");
  return `color-mix(in srgb, ${base} ${mixPct(mag, diag, maxOn, maxOff)}%, transparent)`;
}

// Mix strength: the % of the base hue in the cell fill, normalised within the
// cell's category (the same a as confusionBg).
function mixPct(mag, diag, maxOn, maxOff) {
  const a = diag ? (maxOn ? mag / maxOn : 0) : (maxOff ? mag / maxOff : 0);
  return Math.round((diag ? 15 : 20) + a * (diag ? 55 : 60));
}

// Whether a cell's fill is strong enough that light mode's near-black text reads
// muddy on it — both painters tag such cells .deep, and light-mode CSS flips
// their text to white. (Dark mode is unaffected: its strong fills are bright,
// and the card-coloured halo covers them.)
export const confusionDeep = (mag, diag, maxOn, maxOff) =>
  mag > 0 && mixPct(mag, diag, maxOn, maxOff) >= 60;

// Paint a set of td[data-t][data-p] cells from `maps`: two passes (find the
// per-category maxima, then colour). Sets background, textContent and .empty.
// Grind/probe marking is left to the caller (dashboard's per-vowel matrix only).
export function fillConfusionCells(cells, maps, mode, scheme = "outcome") {
  let maxOn = 0, maxOff = 0;
  const seen = [];
  for (const td of cells) {
    const diag = td.dataset.t === td.dataset.p;
    const v = confusionValue(maps, td.dataset.t, td.dataset.p, mode);
    seen.push([td, diag, v]);
    if (diag) { if (v.mag > maxOn) maxOn = v.mag; } else if (v.mag > maxOff) maxOff = v.mag;
  }
  for (const [td, diag, v] of seen) {
    // No-data cells (never offered): clear the inline bg so the .empty CSS — a
    // light grey fill — shows, instead of pinning transparent over it.
    td.style.background = v.raw === 0 ? "" : confusionBg(v.mag, diag, maxOn, maxOff, scheme);
    td.textContent = v.display;
    td.classList.toggle("empty", v.raw === 0);
    td.classList.toggle("deep", v.raw !== 0 && confusionDeep(v.mag, diag, maxOn, maxOff));
  }
}
