import { describe, it, expect } from "vitest";
import { summariseWalkForward, type FoldMetrics, type FoldOutcome } from "../walk-forward";
import {
  adjustForMultipleTesting,
  assessWalkForwardSignificance,
  benjaminiHochberg,
  binomialTwoSidedP,
  foldCagrDiffs,
  foldsForPower,
  pairedTTest,
  signFlipPermutationTest,
  signTest,
  studentTTwoSidedP,
  tCritical,
  withSignificance,
} from "../walk-forward-significance";

const metrics = (cagrPct: number, over: Partial<FoldMetrics> = {}): FoldMetrics => ({
  totalReturnPct: cagrPct,
  cagrPct,
  maxDrawdownPct: -8,
  sharpe: 0.8,
  volatilityPct: 12,
  days: 90,
  ...over,
});

const outcome = (i: number, cagr: number, bench?: number): FoldOutcome<{ a: number }> => ({
  fold: {
    index: i,
    train: { from: "2020-01-01", to: "2020-06-30" },
    test: { from: "2020-07-01", to: "2020-09-30" },
  },
  params: { a: 1 },
  inSample: metrics(cagr + 2),
  outOfSample: metrics(cagr),
  benchmark: bench === undefined ? null : metrics(bench),
});

describe("distribution helpers", () => {
  it("matches known Student-t two-sided p-values", () => {
    // t=2.228, df=10 → p ≈ 0.05 (standard table value).
    expect(studentTTwoSidedP(2.228, 10)).toBeCloseTo(0.05, 3);
    // t=0 is never surprising.
    expect(studentTTwoSidedP(0, 5)).toBeCloseTo(1, 10);
    // Large t is vanishingly unlikely.
    expect(studentTTwoSidedP(10, 20)).toBeLessThan(1e-8);
  });

  it("recovers table critical values", () => {
    expect(tCritical(10, 0.05)).toBeCloseTo(2.228, 2);
    expect(tCritical(1, 0.05)).toBeCloseTo(12.706, 2);
    // Large df converges on the normal 1.96.
    expect(tCritical(1e6, 0.05)).toBeCloseTo(1.96, 2);
  });

  it("computes exact two-sided binomial tails", () => {
    // 5 of 5 heads: 2 * (1/32).
    expect(binomialTwoSidedP(5, 5)).toBeCloseTo(2 / 32, 10);
    expect(binomialTwoSidedP(0, 5)).toBeCloseTo(2 / 32, 10);
    // A perfectly even split is maximally unsurprising.
    expect(binomialTwoSidedP(5, 10)).toBeCloseTo(1, 10);
    expect(binomialTwoSidedP(8, 10)).toBeCloseTo(0.109375, 6);
  });
});

describe("pairedTTest", () => {
  it("flags a consistent edge as significant", () => {
    const r = pairedTTest([3.1, 2.8, 3.4, 2.9, 3.2, 3.0]);
    expect(r.n).toBe(6);
    expect(r.meanDiff).toBeCloseTo(3.0667, 3);
    expect(r.df).toBe(5);
    expect(r.pValue).toBeLessThan(0.001);
    expect(r.significant).toBe(true);
    expect(r.ci[0]).toBeGreaterThan(0);
    expect(r.effectSize).toBeGreaterThan(2);
  });

  it("does not flag a noisy zero-mean sample", () => {
    const r = pairedTTest([8, -7, 6, -9, 5, -3]);
    expect(r.pValue).toBeGreaterThan(0.2);
    expect(r.significant).toBe(false);
    expect(r.ci[0]).toBeLessThan(0);
    expect(r.ci[1]).toBeGreaterThan(0);
  });

  it("never calls a negative mean significant", () => {
    const r = pairedTTest([-3, -3.2, -2.9, -3.1, -3.05]);
    expect(r.pValue).toBeLessThan(0.001);
    expect(r.significant).toBe(false);
  });

  it("degrades safely on tiny or degenerate samples", () => {
    expect(pairedTTest([]).pValue).toBe(1);
    expect(pairedTTest([5]).pValue).toBe(1);
    expect(pairedTTest([5]).significant).toBe(false);
    const flat = pairedTTest([2, 2, 2, 2]);
    expect(flat.stdDev).toBe(0);
    expect(flat.pValue).toBe(0);
    expect(flat.significant).toBe(true);
  });
});

describe("signTest", () => {
  it("counts positives, negatives and ties", () => {
    const r = signTest([1, -1, 0, 2, 3]);
    expect(r.positives).toBe(3);
    expect(r.negatives).toBe(1);
    expect(r.ties).toBe(1);
    expect(r.n).toBe(4);
  });

  it("is significant only when the wins are lopsided enough", () => {
    expect(signTest(Array.from({ length: 8 }, () => 1)).significant).toBe(true);
    expect(signTest([1, 1, -1, -1]).significant).toBe(false);
    expect(signTest([1, 1, 1, -1]).pValue).toBeCloseTo(0.5, 6);
  });

  it("returns p=1 with no non-tied folds", () => {
    expect(signTest([0, 0]).pValue).toBe(1);
  });
});

describe("signFlipPermutationTest", () => {
  it("enumerates exhaustively for small fold counts", () => {
    const r = signFlipPermutationTest([2, 2, 2, 2, 2]);
    expect(r.exhaustive).toBe(true);
    expect(r.permutations).toBe(32);
    // Only the all-positive and all-negative flips reach |mean| = 2.
    expect(r.pValue).toBeCloseTo(2 / 32, 10);
    expect(r.significant).toBe(true);
  });

  it("gives a large p-value to noise", () => {
    const r = signFlipPermutationTest([5, -4, 3, -6, 2, -1]);
    expect(r.pValue).toBeGreaterThan(0.3);
    expect(r.significant).toBe(false);
  });

  it("is deterministic and non-zero in Monte-Carlo mode", () => {
    const diffs = Array.from({ length: 30 }, (_, i) => 2 + Math.sin(i));
    const a = signFlipPermutationTest(diffs, { iterations: 2000, seed: 7 });
    const b = signFlipPermutationTest(diffs, { iterations: 2000, seed: 7 });
    expect(a.exhaustive).toBe(false);
    expect(a.pValue).toBe(b.pValue);
    expect(a.pValue).toBeGreaterThan(0);
    expect(signFlipPermutationTest(diffs, { iterations: 2000, seed: 99 }).pValue).toBeLessThan(0.05);
  });

  it("refuses to judge fewer than two folds", () => {
    expect(signFlipPermutationTest([4]).pValue).toBe(1);
  });
});

describe("multiple testing", () => {
  it("penalises a searched winner", () => {
    const r = adjustForMultipleTesting(0.03, 50);
    expect(r.bonferroniP).toBe(1);
    expect(r.significant).toBe(false);
    const few = adjustForMultipleTesting(0.001, 10);
    expect(few.bonferroniP).toBeCloseTo(0.01, 10);
    expect(few.sidakP).toBeGreaterThan(0);
    expect(few.sidakP).toBeLessThan(few.bonferroniP + 1e-9);
    expect(few.significant).toBe(true);
  });

  it("controls FDR with Benjamini–Hochberg and stays monotone", () => {
    const out = benjaminiHochberg([0.001, 0.008, 0.039, 0.041, 0.9]);
    expect(out.map((o) => o.index)).toEqual([0, 1, 2, 3, 4]);
    expect(out[0]!.rejected).toBe(true);
    expect(out[4]!.rejected).toBe(false);
    const sortedAdj = [...out].sort((a, b) => a.pValue - b.pValue).map((o) => o.adjustedP);
    for (let i = 1; i < sortedAdj.length; i++) {
      expect(sortedAdj[i]!).toBeGreaterThanOrEqual(sortedAdj[i - 1]! - 1e-12);
    }
    expect(benjaminiHochberg([])).toEqual([]);
  });
});

describe("foldsForPower", () => {
  it("needs fewer folds for a bigger effect", () => {
    const big = foldsForPower(1.5)!;
    const small = foldsForPower(0.3)!;
    expect(big).toBeLessThan(small);
    expect(big).toBeGreaterThan(0);
    expect(foldsForPower(0)).toBeNull();
  });
});

describe("foldCagrDiffs", () => {
  it("pairs against the benchmark when every fold has one", () => {
    const { diffs, paired } = foldCagrDiffs([outcome(0, 10, 6), outcome(1, 12, 7)]);
    expect(paired).toBe(true);
    expect(diffs).toEqual([4, 5]);
  });

  it("falls back to raw CAGR when any benchmark is missing", () => {
    const { diffs, paired } = foldCagrDiffs([outcome(0, 10, 6), outcome(1, 12)]);
    expect(paired).toBe(false);
    expect(diffs).toEqual([10, 12]);
  });
});

describe("assessWalkForwardSignificance", () => {
  it("calls a persistent benchmark-beating edge significant", () => {
    const outcomes = [
      outcome(0, 11, 6),
      outcome(1, 12.5, 7),
      outcome(2, 10.5, 6.2),
      outcome(3, 13, 8),
      outcome(4, 11.8, 6.9),
      outcome(5, 12.1, 7.4),
    ];
    const res = assessWalkForwardSignificance(outcomes);
    expect(res.paired).toBe(true);
    expect(res.folds).toBe(6);
    expect(res.meanDiffPct).toBeGreaterThan(4);
    expect(res.tTest.pValue).toBeLessThan(0.01);
    expect(res.permutation.pValue).toBeCloseTo(2 / 64, 10);
    expect(res.verdict).toBe("significant");
    expect(res.sentence).toMatch(/unlikely to be chance/);
  });

  it("calls a noisy edge not significant", () => {
    const outcomes = [
      outcome(0, 14, 6),
      outcome(1, 1, 8),
      outcome(2, 18, 4),
      outcome(3, -6, 9),
      outcome(4, 3, 2),
      outcome(5, -4, 5),
    ];
    const res = assessWalkForwardSignificance(outcomes);
    expect(res.verdict).toBe("not-significant");
    expect(res.headlineP).toBeGreaterThan(0.05);
    expect(res.sentence).toMatch(/indistinguishable from chance/);
  });

  it("refuses to judge too few folds", () => {
    const res = assessWalkForwardSignificance([outcome(0, 20, 1), outcome(1, 22, 2)]);
    expect(res.verdict).toBe("insufficient");
    expect(res.sentence).toMatch(/too few/);
  });

  it("downgrades a winner picked out of a wide search", () => {
    const outcomes = [
      outcome(0, 9, 6),
      outcome(1, 10, 7),
      outcome(2, 8.5, 6.2),
      outcome(3, 11, 8),
      outcome(4, 9.4, 6.9),
      outcome(5, 10.2, 7.4),
    ];
    const clean = assessWalkForwardSignificance(outcomes);
    const searched = assessWalkForwardSignificance(outcomes, { trials: 200 });
    expect(clean.verdict).toBe("significant");
    expect(searched.multipleTesting!.trials).toBe(200);
    expect(searched.headlineP).toBeGreaterThan(clean.headlineP);
    expect(searched.verdict).not.toBe("significant");
    expect(searched.sentence).toMatch(/200 searched configs/);
  });

  it("is deterministic", () => {
    const outcomes = Array.from({ length: 25 }, (_, i) => outcome(i, 8 + (i % 5), 6));
    const a = assessWalkForwardSignificance(outcomes, { iterations: 3000, seed: 4 });
    const b = assessWalkForwardSignificance(outcomes, { iterations: 3000, seed: 4 });
    expect(a.headlineP).toBe(b.headlineP);
    expect(a.verdict).toBe(b.verdict);
  });
});

describe("withSignificance", () => {
  const outcomes = [
    outcome(0, 14, 6),
    outcome(1, 1, 8),
    outcome(2, 18, 4),
    outcome(3, -6, 9),
    outcome(4, 3, 2),
    outcome(5, -4, 5),
  ];

  it("keeps the summary intact and appends a caveat when not significant", () => {
    const summary = summariseWalkForward(outcomes);
    const out = withSignificance(summary, outcomes);
    expect(out.folds).toBe(summary.folds);
    expect(out.oosCagrPct).toBe(summary.oosCagrPct);
    expect(out.significance.verdict).toBe("not-significant");
    expect(out.reasons).toContain(out.significance.sentence);
    expect(out.reasons.length).toBe(summary.reasons.length + 1);
  });

  it("adds no caveat when the edge is significant", () => {
    const strong = [
      outcome(0, 11, 6),
      outcome(1, 12.5, 7),
      outcome(2, 10.5, 6.2),
      outcome(3, 13, 8),
      outcome(4, 11.8, 6.9),
      outcome(5, 12.1, 7.4),
    ];
    const summary = summariseWalkForward(strong);
    const out = withSignificance(summary, strong);
    expect(out.significance.verdict).toBe("significant");
    expect(out.reasons).toEqual(summary.reasons);
  });
});
