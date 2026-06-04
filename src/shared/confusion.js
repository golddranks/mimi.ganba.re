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
