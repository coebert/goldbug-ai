import { describe, expect, it } from "vitest";
import {
  runCostSensitivity,
  costSensitivityReportText,
  axisValueOf,
  DEFAULT_COST_LADDERS,
  type SensitivityRunner,
} from "@/lib/backtest/preset-cost-sensitivity";
import { ASSUMPTION_PRESETS } from "@/lib/backtest/execution-assumptions";

/**
 * Deterministic stand-in for a replay: gross return of 12pp, eaten by
 * commission, half the quoted spread and slippage over 20 round trips.
 */
const linearRunner: SensitivityRunner = (a) => {
  const perTripBps = a.commissionMult * 8 + a.spreadBps / 2 + a.slippageBps;
  const frictionPct = (perTripBps * 20) / 100;
  return {
    totalReturnPct: 12 - frictionPct,
    maxDrawdownPct: 5 + frictionPct / 2,
    tradesAdmitted: 20,
    frictionBpsOfEquity: perTripBps * 20,
  };
};

describe("runCostSensitivity", () => {
  it("sweeps every preset on every axis and marks the preset's own point", () => {
    const r = runCostSensitivity(linearRunner);
    expect(r.presets.map((p) => p.preset)).toEqual(
      Object.keys(ASSUMPTION_PRESETS),
    );
    for (const p of r.presets) {
      expect(p.axes.map((a) => a.axis)).toEqual(["fees", "spread", "slippage"]);
      for (const a of p.axes) {
        const own = axisValueOf(ASSUMPTION_PRESETS[p.preset], a.axis);
        const marked = a.points.filter((pt) => pt.isBaseline);
        expect(marked).toHaveLength(1);
        expect(marked[0]!.value).toBe(own);
        expect(marked[0]!.totalReturnPct).toBeCloseTo(p.baseline.totalReturnPct, 8);
      }
    }
  });

  it("measures a negative elasticity and finds the breakeven cost", () => {
    const r = runCostSensitivity(linearRunner, { presets: ["live"] });
    const spread = r.presets[0]!.axes.find((a) => a.axis === "spread")!;
    // 20 trips x half-spread: 1bps of quoted spread costs 0.1pp.
    expect(spread.elasticity).toBeCloseTo(-0.1, 3);
    const slip = r.presets[0]!.axes.find((a) => a.axis === "slippage")!;
    expect(slip.elasticity).toBeCloseTo(-0.2, 3);
    // live = 8bps commission x 20 trips = 1.6pp, leaving 10.4pp for slippage:
    // breakeven at 10.4 / 0.2 = 52bps, beyond the default ladder.
    expect(slip.breakevenValue).toBeNull();
    const wide = runCostSensitivity(linearRunner, {
      presets: ["live"],
      axes: ["slippage"],
      ladders: { slippage: [0, 25, 50, 75] },
    });
    const bev = wide.presets[0]!.axes[0]!.breakevenValue!;
    expect(bev).toBeGreaterThan(45);
    expect(bev).toBeLessThan(60);
    expect(wide.presets[0]!.verdict).toBe("fragile");
  });

  it("flags a preset whose baseline is already losing money", () => {
    const r = runCostSensitivity(
      (a) => ({ ...linearRunner(a), totalReturnPct: -3 }),
      { presets: ["pessimistic"], axes: ["fees"] },
    );
    expect(r.presets[0]!.verdict).toBe("unprofitable");
    expect(r.robustPresets).toEqual([]);
  });

  it("names the axis that does the most damage across its plausible range", () => {
    const spreadHeavy: SensitivityRunner = (a) => ({
      totalReturnPct: 20 - a.spreadBps * 0.4 - a.slippageBps * 0.01,
      maxDrawdownPct: 6,
      tradesAdmitted: 10,
      frictionBpsOfEquity: 100,
    });
    expect(runCostSensitivity(spreadHeavy).dominantAxis).toBe("spread");
  });

  it("keeps a profitable-everywhere strategy robust with no breakeven", () => {
    const cheap: SensitivityRunner = () => ({
      totalReturnPct: 30,
      maxDrawdownPct: 4,
      tradesAdmitted: 12,
      frictionBpsOfEquity: 40,
    });
    const r = runCostSensitivity(cheap, { presets: ["realistic"] });
    expect(r.presets[0]!.verdict).toBe("robust");
    expect(r.robustPresets).toEqual(["realistic"]);
    expect(r.presets[0]!.axes.every((a) => a.breakevenValue === null)).toBe(true);
  });

  it("renders a text report covering each preset and ladder point", () => {
    const text = costSensitivityReportText(
      runCostSensitivity(linearRunner, { presets: ["optimistic", "realistic"] }),
    );
    expect(text).toContain("OPTIMISTIC");
    expect(text).toContain("REALISTIC");
    expect(text).toContain("Quoted spread (bps)");
    for (const v of DEFAULT_COST_LADDERS.slippage) expect(text).toContain(String(v));
    expect(text).toContain("verdict:");
  });
});
