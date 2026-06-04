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
