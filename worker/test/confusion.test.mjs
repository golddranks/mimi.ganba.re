// Unit tests for the grind/probe target math (src/shared/confusion.js) — pure,
// no worker or DOM. Covers the Beta(1,4) posterior threshold and the grind /
// best-grind / probe selection the dashboard borders and grind mode rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pAbove20, confusionTargets } from "../../src/shared/confusion.js";

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
  const { grind, bestGrind, probe } = confusionTargets(shown, offered);

  // Both high-rate cases are confidently >20% → grind; best grind is the higher rate.
  assert.deepEqual([...grind].sort(), ["sa/za", "ta/za"]);
  assert.equal(bestGrind, "sa/za");          // 10/10 beats 6/10

  // Probe = highest-rate *uncertain* case. su/zu (0.67) beats so/zo (0.25);
  // si/zi (0/20) is confidently <20% and excluded.
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
