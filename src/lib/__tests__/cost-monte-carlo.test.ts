import { describe, expect, it } from "vitest";
import {
  CHURN_VERDICT_LABEL,
  DEFAULT_COST_SPEC,
  churnImpact,
  cvar,
  describeDistribution,
  dominantAxis,
  explainChurn,
  formatCohort,
  frictionsFromDraw,
  percentile,
  regressOnCosts,
  sampleCostDraws,
  summariseByCohort,
  summariseCohort,
  type CostDraw,
  type CostTrial,
} from "../cost-monte-carlo";

const draw = (commissionBps: number, minCommission: number, slippageBps: number): CostDraw => ({
  commissionBps,
  minCommission,
  slippageBps,
  stress: 0.5,
});

/** Synthetic trial generator: net CAGR falls linearly with each cost axis. */
function makeTrials(cohort: string, turnover: number, n = 40): CostTrial[] {
  const draws = sampleCostDraws(n, DEFAULT_COST_SPEC, 7);
  return draws.map((d) => {
    const churn = turnover / 50;
    const netCagrPct = 12 - churn * (0.4 * d.commissionBps + 0.8 * d.minCommission + 0.3 * d.slippageBps);
    return {
      cohort,
      draw: d,
      netCagrPct,
      maxDrawdownPct: 15 + churn * 0.2 * d.slippageBps,
      sharpe: 0.8,
      tradesPerYear: turnover,
      feeDragPct: churn * (d.commissionBps * 0.1 + d.minCommission * 0.4),
    };
  });
}

describe("sampleCostDraws", () => {
  it("is deterministic for a seed and stays inside the configured ranges", () => {
    const a = sampleCostDraws(25, DEFAULT_COST_SPEC, 42);
    const b = sampleCostDraws(25, DEFAULT_COST_SPEC, 42);
    expect(a).toEqual(b);
    for (const d of a) {
      expect(d.commissionBps).toBeGreaterThanOrEqual(DEFAULT_COST_SPEC.commissionBps.min);
      expect(d.commissionBps).toBeLessThanOrEqual(DEFAULT_COST_SPEC.commissionBps.max);
      expect(d.minCommission).toBeGreaterThanOrEqual(DEFAULT_COST_SPEC.minCommission.min);
      expect(d.minCommission).toBeLessThanOrEqual(DEFAULT_COST_SPEC.minCommission.max);
      expect(d.slippageBps).toBeGreaterThanOrEqual(DEFAULT_COST_SPEC.slippageBps.min);
      expect(d.slippageBps).toBeLessThanOrEqual(DEFAULT_COST_SPEC.slippageBps.max);
      expect(d.stress).toBeGreaterThanOrEqual(0);
      expect(d.stress).toBeLessThanOrEqual(1);
    }
  });

  it("different seeds give different worlds", () => {
    expect(sampleCostDraws(10, DEFAULT_COST_SPEC, 1)).not.toEqual(
      sampleCostDraws(10, DEFAULT_COST_SPEC, 2),
    );
  });

  it("the common factor correlates the axes", () => {
    const corr = (ds: CostDraw[]) => {
      const xs = ds.map((d) => d.commissionBps);
      const ys = ds.map((d) => d.minCommission);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0);
      const vx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
      const vy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
      return cov / (vx * vy);
    };
    const independent = corr(sampleCostDraws(400, { ...DEFAULT_COST_SPEC, commonFactor: 0 }, 3));
    const linked = corr(sampleCostDraws(400, { ...DEFAULT_COST_SPEC, commonFactor: 1 }, 3));
    expect(Math.abs(independent)).toBeLessThan(0.2);
    expect(linked).toBeGreaterThan(0.9);
  });

  it("the fat tail skews slippage toward the cheap end", () => {
    const median = (tail: "linear" | "fat") =>
      percentile(
        sampleCostDraws(500, { ...DEFAULT_COST_SPEC, slippageTail: tail }, 11).map((d) => d.slippageBps),
        0.5,
      );
    expect(median("fat")).toBeLessThan(median("linear"));
  });

  it("rejects bad inputs", () => {
    expect(() => sampleCostDraws(0)).toThrow();
    expect(() => sampleCostDraws(5, { ...DEFAULT_COST_SPEC, slippageBps: { min: 5, max: 1 } })).toThrow();
    expect(() => sampleCostDraws(5, { ...DEFAULT_COST_SPEC, minCommission: { min: -1, max: 3 } })).toThrow();
  });
});

describe("frictionsFromDraw", () => {
  it("overlays the three axes and preserves the rest", () => {
    const base = { commissionBps: 8, minCommission: 3, buyTaxBps: 50, slippageBps: 5, impactPerUnit: 0.0002 };
    const f = frictionsFromDraw(base, draw(11, 6, 18));
    expect(f).toEqual({ ...base, commissionBps: 11, minCommission: 6, slippageBps: 18 });
  });
});

describe("distribution helpers", () => {
  it("interpolates percentiles", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(percentile(xs, 0.5)).toBe(3);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 1)).toBe(5);
    expect(percentile([10], 0.9)).toBe(10);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it("summarises a sample", () => {
    const d = describeDistribution([0, 10, 20, 30, 40]);
    expect(d.median).toBe(20);
    expect(d.mean).toBe(20);
    expect(d.p5).toBeLessThan(d.p95);
  });

  it("cvar averages the worst tail", () => {
    expect(cvar([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.2)).toBe(1.5);
    expect(cvar([5], 0.05)).toBe(5);
  });
});

describe("regressOnCosts", () => {
  it("recovers known partial slopes", () => {
    const trials: CostTrial[] = sampleCostDraws(200, { ...DEFAULT_COST_SPEC, commonFactor: 0 }, 5).map(
      (d) => ({
        cohort: "x",
        draw: d,
        netCagrPct: 20 - 0.5 * d.commissionBps - 1.2 * d.minCommission - 0.25 * d.slippageBps,
        maxDrawdownPct: 12,
        sharpe: 1,
        tradesPerYear: 40,
        feeDragPct: 2,
      }),
    );
    const s = regressOnCosts(trials);
    expect(s.perCommissionBp).toBeCloseTo(-0.5, 4);
    expect(s.perMinFee).toBeCloseTo(-1.2, 4);
    expect(s.perSlippageBp).toBeCloseTo(-0.25, 4);
    expect(s.r2).toBeCloseTo(1, 6);
  });

  it("returns a neutral result when the sample is too small", () => {
    expect(regressOnCosts([]).r2).toBe(0);
    expect(regressOnCosts(makeTrials("a", 40, 3)).perSlippageBp).toBe(0);
  });
});

describe("cohort summaries", () => {
  it("computes distributions, pass rates and sensitivities", () => {
    const s = summariseCohort("high churn", makeTrials("high churn", 100), 20);
    expect(s.trials).toBe(40);
    expect(s.tradesPerYear).toBe(100);
    expect(s.netCagr.p5).toBeLessThanOrEqual(s.netCagr.median);
    expect(s.netCagr.median).toBeLessThanOrEqual(s.netCagr.p95);
    expect(s.profitableRate).toBeGreaterThanOrEqual(0);
    expect(s.profitableRate).toBeLessThanOrEqual(1);
    expect(s.drawdownPassRate).toBeGreaterThanOrEqual(0);
    expect(s.cvarNetCagr).toBeLessThanOrEqual(s.netCagr.median);
    expect(s.cvarDrawdown).toBeGreaterThanOrEqual(s.maxDrawdown.median);
    expect(s.sensitivity.perSlippageBp).toBeLessThan(0);
    expect(s.drawdownSlippageSlope).toBeGreaterThan(0);
  });

  it("groups by cohort in ascending turnover order", () => {
    const trials = [...makeTrials("high", 120), ...makeTrials("low", 20), ...makeTrials("mid", 60)];
    expect(summariseByCohort(trials).map((s) => s.cohort)).toEqual(["low", "mid", "high"]);
  });

  it("formats a readable line", () => {
    const line = formatCohort(summariseCohort("low churn", makeTrials("low churn", 20)));
    expect(line).toContain("low churn");
    expect(line).toContain("net CAGR");
    expect(line).toContain("maxDD");
  });
});

describe("churnImpact", () => {
  const summaries = summariseByCohort([
    ...makeTrials("low churn", 20),
    ...makeTrials("medium churn", 60),
    ...makeTrials("high churn", 140),
  ]);

  it("compares the slowest and fastest cohorts under the same draws", () => {
    const impact = churnImpact(summaries)!;
    expect(impact.baseline).toBe("low churn");
    expect(impact.churned).toBe("high churn");
    expect(impact.extraTradesPerYear).toBe(120);
    // Churn is pure cost in the synthetic model, so it must show up as a loss.
    expect(impact.medianCagrCostPct).toBeGreaterThan(0);
    expect(impact.cagrPerExtraTrade).toBeCloseTo(impact.medianCagrCostPct / 120, 6);
    expect(impact.extraFeeDragPct).toBeGreaterThan(0);
    expect(impact.tailDrawdownCostPct).toBeGreaterThan(0);
    expect(impact.spreadAmplification).toBeGreaterThan(1);
    expect(impact.verdict).toBe("churn-dominated");
  });

  it("calls out a tolerant strategy when churn barely costs anything", () => {
    const flat = (cohort: string, turnover: number): CostTrial[] =>
      sampleCostDraws(30, DEFAULT_COST_SPEC, 9).map((d) => ({
        cohort,
        draw: d,
        netCagrPct: 10 - 0.01 * d.slippageBps,
        maxDrawdownPct: 12,
        sharpe: 1,
        tradesPerYear: turnover,
        feeDragPct: 1,
      }));
    const impact = churnImpact(summariseByCohort([...flat("slow", 10), ...flat("fast", 90)]))!;
    expect(impact.verdict).toBe("churn-tolerant");
    expect(Math.abs(impact.medianCagrCostPct)).toBeLessThan(1);
  });

  it("returns null with fewer than two cohorts", () => {
    expect(churnImpact(summariseByCohort(makeTrials("only", 30)))).toBeNull();
    expect(churnImpact([])).toBeNull();
  });
});

describe("reporting", () => {
  it("picks the axis with the widest range-weighted impact", () => {
    expect(
      dominantAxis({ perCommissionBp: -0.1, perMinFee: -5, perSlippageBp: -0.1, r2: 0.9 }),
    ).toBe("min fee");
    expect(
      dominantAxis({ perCommissionBp: -0.1, perMinFee: -0.01, perSlippageBp: -2, r2: 0.9 }),
    ).toBe("slippage");
  });

  it("explains the churn verdict in plain language", () => {
    const summaries = summariseByCohort([...makeTrials("low", 20), ...makeTrials("high", 140)]);
    const text = explainChurn(churnImpact(summaries), DEFAULT_COST_SPEC, summaries[1]!.sensitivity);
    expect(text).toContain(CHURN_VERDICT_LABEL["churn-dominated"]);
    expect(text).toContain("round-trips/yr");
    expect(text).toContain("Dominant cost axis");
    expect(explainChurn(null)).toContain("Not enough cohorts");
  });
});
