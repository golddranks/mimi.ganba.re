// Unit tests for the grind/probe target math (src/shared/confusion.js) — pure,
// no worker or DOM. Covers the Beta(1,4) posterior threshold and the grind /
// best-grind / probe selection the dashboard borders and grind mode rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pAbove20, confusionTargets, logisticFit, logisticAt, logisticTrend } from "../../src/shared/confusion.js";
import { confusionExtras } from "../../src/shared/tally.js";

test("confusionExtras: guessed (incl. correct→diagonal), after-played, re-listened by order", () => {
  const ev = (ts, ms, kind, picked, opts) => ({ target: "sa", ts, ms, ev: kind, picked, opts: opts && opts.join(",") });
  const events = [
    // Q1: re-listen then a *wrong* guess of za. ts-ms is 1000 for the 'r' but 1003
    // for the answer — they DON'T match (as in real data), so order, not ts-ms,
    // must link them. offered: sa, za.
    ev(1200, 200, "r", ""),
    ev(1503, 500, "g", "za", ["sa", "za"]),
    // Q2: correct guess of sa (→ diagonal), no re-listen.
    ev(2400, 400, "g", "sa", ["sa", "za"]),
    // Q3: plain answer, then after-played za during review.
    ev(3400, 400, "a", "sa", ["sa", "za"]),
    ev(3900, 900, "p", "za"),
  ];
  const { guessed, afterPlayed, reListened } = confusionExtras(events);
  assert.equal(guessed["sa/za"], 1, "wrong guess of za");
  assert.equal(guessed["sa/sa"], 1, "correct guess lands on the diagonal");
  assert.equal(afterPlayed["sa/za"], 1, "replayed za in review");
  assert.equal(reListened["sa/sa"], 1, "re-listen credited to every offered kana despite ts-ms mismatch");
  assert.equal(reListened["sa/za"], 1, "...and the confuser");
  assert.equal(afterPlayed["sa/sa"], undefined, "no stray after-play");
});

test("confusionExtras: start_ts pairs a re-listen with its own question, not a later one", () => {
  const events = [
    // Q1 (start_ts 1000): re-listen, then ABANDONED (refresh — no answer for it).
    { target: "sa", ts: 1200, ms: 200, ev: "r", picked: "", start_ts: 1000 },
    // Q2 (start_ts 2000, same sound): answered, with no re-listen of its own.
    { target: "sa", ts: 2400, ms: 400, ev: "a", picked: "za", opts: "sa,za", start_ts: 2000 },
    // Q3 (start_ts 3000): re-listen then its own answer → credited.
    { target: "su", ts: 3100, ms: 100, ev: "r", picked: "", start_ts: 3000 },
    { target: "su", ts: 3500, ms: 500, ev: "a", picked: "su", opts: "su,tu", start_ts: 3000 },
  ];
  const { reListened } = confusionExtras(events);
  assert.equal(reListened["sa/za"], undefined, "abandoned re-listen not credited to a later same-sound question");
  assert.equal(reListened["sa/sa"], undefined, "...nor its diagonal");
  assert.equal(reListened["su/su"], 1, "a re-listen with its matching answer (same start_ts) is credited");
  assert.equal(reListened["su/tu"], 1, "...to every offered kana");
});

test("confusionExtras: slow = slowest engaged (<6s) reactions at the 96th pct", () => {
  // 10 sa→za picks at ms 100..1000 (engaged) + one 7000ms (away, not hesitating).
  // 96th pct of the engaged set is the slowest (1000), so only that pick is "slow";
  // the 7s one is excluded by the <6s cap.
  const mk = (ms) => ({ target: "sa", ts: 1_000_000 + ms, ms, ev: "a", picked: "za", opts: "sa,za" });
  const events = [...Array(10)].map((_, i) => mk((i + 1) * 100)).concat(mk(7000));
  const { slow } = confusionExtras(events);
  assert.equal(slow["sa/za"], 1, "only the slowest engaged reaction; the 7s away-answer doesn't count");
});

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
