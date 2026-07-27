import { describe, it, expect } from "vitest";
import {
  evaluateShadow,
  DEFAULT_SHADOW_EVAL_OPTIONS,
} from "@/lib/microstructure/algo-regime-shadow-eval";
import type { CalibrationReport } from "@/lib/microstructure/algo-regime-calibration";

function report(opts: {
  matched: number;
  monotone: boolean;
  normal: { count: number; mean: number };
  elevated?: { count: number; mean: number };
  extreme: { count: number; mean: number };
}): CalibrationReport {
  const mkTier = (
    tier: "normal" | "elevated" | "extreme",
    c: { count: number; mean: number },
  ) => ({
    tier,
    count: c.count,
    meanReturn: c.mean,
    stdReturn: 0,
    hitRate: 0.5,
    worstReturn: c.mean - 0.01,
  });
  return {
    matched: opts.matched,
    unmatched: 0,
    monotone: opts.monotone,
    perTier: [
      mkTier("normal", opts.normal),
      mkTier("elevated", opts.elevated ?? { count: 0, mean: 0 }),
      mkTier("extreme", opts.extreme),
    ],
  };
}

describe("evaluateShadow", () => {
  it("waits when there are too few post-tune samples", () => {
    const base = report({
      matched: 40, monotone: true,
      normal: { count: 30, mean: 0.005 },
      extreme: { count: 5, mean: -0.02 },
    });
    const post = report({
      matched: 3, monotone: true,
      normal: { count: 3, mean: 0.006 },
      extreme: { count: 0, mean: 0 },
    });
    const d = evaluateShadow(base, post);
    expect(d.action).toBe("wait");
  });

  it("rolls back when a previously monotone ladder inverts", () => {
    const base = report({
      matched: 60, monotone: true,
      normal: { count: 40, mean: 0.006 },
      extreme: { count: 10, mean: -0.02 },
    });
    const post = report({
      matched: 20, monotone: false,
      normal: { count: 10, mean: 0.004 },
      extreme: { count: 5, mean: 0.010 }, // extreme now BETTER than normal
    });
    const d = evaluateShadow(base, post);
    expect(d.action).toBe("rollback");
    expect(d.reason).toMatch(/inverted/);
  });

  it("rolls back on material normal-tier regression", () => {
    const base = report({
      matched: 60, monotone: true,
      normal: { count: 40, mean: 0.010 },
      extreme: { count: 10, mean: -0.02 },
    });
    const post = report({
      matched: 30, monotone: true,
      normal: { count: 20, mean: 0.001 }, // -90bps regression, > 50bp tol
      extreme: { count: 5, mean: -0.03 },
    });
    const d = evaluateShadow(base, post);
    expect(d.action).toBe("rollback");
    expect(d.reason).toMatch(/regressed/);
  });

  it("keeps when the ladder stays healthy", () => {
    const base = report({
      matched: 60, monotone: true,
      normal: { count: 40, mean: 0.006 },
      extreme: { count: 10, mean: -0.02 },
    });
    const post = report({
      matched: 25, monotone: true,
      normal: { count: 18, mean: 0.008 },
      extreme: { count: 4, mean: -0.03 },
    });
    const d = evaluateShadow(base, post);
    expect(d.action).toBe("keep");
    expect(d.normalMeanDelta).toBeCloseTo(0.002, 5);
  });

  it("does not rollback on non-monotone flip without enough extreme samples", () => {
    const base = report({
      matched: 60, monotone: true,
      normal: { count: 40, mean: 0.006 },
      extreme: { count: 10, mean: -0.02 },
    });
    const post = report({
      matched: 20, monotone: false,
      normal: { count: 18, mean: 0.005 },
      extreme: { count: 1, mean: 0.05 }, // only 1 sample — untrustworthy
    });
    const d = evaluateShadow(base, post, {
      ...DEFAULT_SHADOW_EVAL_OPTIONS,
      minExtremeSamplesForMonotoneCheck: 3,
    });
    expect(d.action).toBe("keep");
  });
});
