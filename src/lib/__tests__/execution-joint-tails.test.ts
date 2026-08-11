import { describe, it, expect } from "vitest";
import {
  jointDrawdownBreachProbabilities,
  conditionalTailStats,
} from "../execution-monte-carlo";

describe("jointDrawdownBreachProbabilities", () => {
  const dds = [-4, -12, -16, -22, -30];
  //           calm  stress calm  stress stress
  const inStress = [false, true, false, true, true];

  it("splits each breach into the part that happened in stress", () => {
    const [ten, twenty] = jointDrawdownBreachProbabilities(dds, inStress, [10, 20]);
    expect(ten!.count).toBe(4);
    expect(ten!.jointCount).toBe(3);
    expect(ten!.prob).toBeCloseTo(0.8, 9);
    expect(ten!.jointProb).toBeCloseTo(0.6, 9);
    expect(ten!.probStressGivenBreach).toBeCloseTo(0.75, 9);
    expect(twenty!.count).toBe(2);
    expect(twenty!.jointCount).toBe(2);
    expect(twenty!.probStressGivenBreach).toBeCloseTo(1, 9);
  });

  it("never reports a joint probability above the marginal one", () => {
    for (const b of jointDrawdownBreachProbabilities(dds, inStress, [5, 10, 15, 20, 25, 30])) {
      expect(b.jointProb).toBeLessThanOrEqual(b.prob + 1e-12);
      expect(b.jointCount).toBeLessThanOrEqual(b.count);
    }
  });

  it("treats a missing stress flag as calm and matches the marginal breach count", () => {
    const b = jointDrawdownBreachProbabilities([-20, -20], [], [10])[0]!;
    expect(b.count).toBe(2);
    expect(b.jointCount).toBe(0);
    expect(b.probStressGivenBreach).toBe(0);
  });

  it("returns NaN probabilities with no usable sample", () => {
    const b = jointDrawdownBreachProbabilities([], [], [10])[0]!;
    expect(b.prob).toBeNaN();
    expect(b.jointProb).toBeNaN();
    expect(b.probStressGivenBreach).toBeNaN();
  });
});

describe("conditionalTailStats", () => {
  // Returns get worse as stress exposure rises — the whole point of conditioning.
  const returns = [10, 9, 8, 7, 6, 5, 4, 3, 2, -6];
  const exposure = [5, 8, 10, 12, 15, 18, 22, 26, 30, 40];

  it("conditions on the worst-stress paths and reports their tail", () => {
    const s = conditionalTailStats(returns, exposure, 0.8, 0.5);
    // Top 20% by exposure = the two ugliest tapes.
    expect(s.count).toBe(2);
    expect(s.share).toBeCloseTo(0.2, 9);
    expect(s.worst).toBe(-6);
    expect(s.mean).toBeCloseTo(-2, 9);
    // Worst half of a 2-path subset = the single worst path.
    expect(s.cvar).toBeCloseTo(-6, 9);
  });

  it("is at least as bad as the unconditional mean when stress hurts", () => {
    const cond = conditionalTailStats(returns, exposure, 0.8, 0.2);
    const uncond = returns.reduce((a, b) => a + b, 0) / returns.length;
    expect(cond.mean).toBeLessThan(uncond);
  });

  it("widens the subset as the quantile drops", () => {
    const tight = conditionalTailStats(returns, exposure, 0.9, 0.2);
    const loose = conditionalTailStats(returns, exposure, 0.5, 0.2);
    expect(loose.count).toBeGreaterThan(tight.count);
    expect(loose.cutoff).toBeLessThan(tight.cutoff);
  });

  it("falls back to the full sample when exposure is degenerate", () => {
    const s = conditionalTailStats([3, 1, 2], [7, 7, 7], 0.8, 0.34);
    expect(s.count).toBe(3);
    expect(s.worst).toBe(1);
    expect(s.cvar).toBeCloseTo(1, 9);
  });

  it("drops rows with non-finite values or exposure, and is empty-safe", () => {
    const s = conditionalTailStats([1, NaN, 3], [1, 2, NaN], 0, 1);
    expect(s.count).toBe(1);
    expect(s.mean).toBe(1);
    const empty = conditionalTailStats([], [], 0.8, 0.2);
    expect(empty.count).toBe(0);
    expect(empty.cvar).toBeNaN();
  });

  it("always keeps at least one path in the tail", () => {
    const s = conditionalTailStats(returns, exposure, 0.8, 0);
    expect(s.cvar).toBe(s.worst);
  });
});
