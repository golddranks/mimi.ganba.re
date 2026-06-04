// Unit tests for the grind/probe target math (src/shared/confusion.js) — pure,
// no worker or DOM. Covers the Beta(1,4) posterior threshold and the grind /
// best-grind / probe selection the dashboard borders and grind mode rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pAbove20, confusionTargets, logisticFit, logisticAt, logisticTrend } from "../../src/shared/confusion.js";

test("logisticFit captures trend direction over a 0/1 sequence", () => {
  const up = logisticFit([0, 0, 0, 0, 1, 1, 1, 1]);
  const down = logisticFit([1, 1, 1, 1, 0, 0, 0, 0]);
  assert.ok(logisticAt(up, 1) - logisticAt(up, 0) > 0.1, "rising sequence trends up");
  assert.ok(logisticAt(down, 1) - logisticAt(down, 0) < -0.1, "falling sequence trends down");
  assert.equal(logisticFit([1]), null, "needs at least two points");
});

test("logisticTrend only flags statistically real trends", () => {
  // 8 noisy points (50% then 75% red) — not a real trend.
  assert.equal(logisticTrend([1, 0, 0, 1, 0, 1, 1, 1]).significant, false);
  // 30 noisy points, no drift — not a trend despite ample data.
  assert.equal(logisticTrend(Array.from({ length: 30 }, (_, i) => [1, 0, 1, 1, 0, 0, 1, 0, 1, 0][i % 10])).significant, false);
  // Clean red→green flip — improving (bad rate falls).
  const imp = logisticTrend([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  assert.ok(imp.significant && imp.improving, "clean red→green is improving");
  // Clean green→red flip — worsening.
  const wor = logisticTrend([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  assert.ok(wor.significant && !wor.improving, "clean green→red is worsening");
  // Too few points — no trend.
  assert.equal(logisticTrend([1, 0, 1]).significant, false);
});

test("pAbove20 matches the Beta-binomial identity", () => {
  // 0/0 is the Beta(1,4) prior: P(p>0.2) = 1 - CDF(0.2) = (1-0.2)^4 = 0.4096.
  assert.ok(Math.abs(pAbove20(0, 0) - 0.4096) < 1e-9);
  assert.ok(pAbove20(10, 10) > 0.95);                       // confidently > 20%
  assert.ok(pAbove20(3, 3) > 0.95);
  const mid = pAbove20(2, 3);
  assert.ok(mid > 0.05 && mid < 0.95);                      // uncertain
  assert.ok(pAbove20(0, 20) < 0.05);                        // confidently < 20%
});

test("confusionTargets picks grind set, highest-rate best grind, and the probe", () => {
  const shown   = { "sa/za": 10, "ta/za": 6, "su/zu": 2, "so/zo": 1, "si/zi": 0 };
  const offered = { "sa/za": 10, "ta/za": 10, "su/zu": 3, "so/zo": 4, "si/zi": 20 };
  const { grind, bestGrind, probes, probe } = confusionTargets(shown, offered);

  // Both high-rate cases are confidently >20% → grind; best grind is the higher rate.
  assert.deepEqual([...grind].sort(), ["sa/za", "ta/za"]);
  assert.equal(bestGrind, "sa/za");          // 10/10 beats 6/10

  // probes = every uncertain case; si/zi (0/20) is confidently <20% and excluded.
  assert.deepEqual([...probes].sort(), ["so/zo", "su/zu"]);
  // probe = the single highest-rate uncertain one (su/zu 0.67 beats so/zo 0.25).
  assert.equal(probe, "su/zu");
});

test("confusionTargets ignores the diagonal and zero-offer cells", () => {
  const shown = { "sa/sa": 50, "sa/za": 9 };
  const offered = { "sa/sa": 50, "sa/za": 10, "su/zu": 0 };
  const { grind, probe, bestGrind } = confusionTargets(shown, offered);
  assert.ok(!grind.has("sa/sa"));            // diagonal is never a case
  assert.ok(grind.has("sa/za"));             // 9/10 wrong → grind
  assert.equal(bestGrind, "sa/za");
  assert.equal(probe, null);                 // su/zu has no offers; nothing uncertain
});
