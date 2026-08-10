import { describe, it, expect } from "vitest";
import {
  buildBreakoutDecisionAudit,
  cellVerdict,
  explainBreakoutDecision,
} from "../breakout-decision-audit";
import type { BreakoutRegimeDecision } from "../alpha/breakout-regime-policy";
import type { BreakoutEvidence } from "../alpha/breakout";

const evidence: BreakoutEvidence = {
  state: "confirmed",
  direction: "up",
  level: 101,
  channel_high: 101,
  channel_low: 90,
  distance_to_high_atr: -0.4,
  penetration_atr: 0.6,
  base_width_pct: 0.08,
  base_bars: 30,
  volume_ratio: 1.8,
  bars_since_breakout: 2,
  prior_attempts: 3,
  prior_failures: 1,
  false_breakout_rate: 0.33,
  quality: 0.72,
  actionable: true,
  reasons: [],
};

function decision(over: Partial<BreakoutRegimeDecision> = {}): BreakoutRegimeDecision {
  return {
    action: "downsize",
    mult: 0.5,
    rawMult: 1.2,
    bucket: "sideways",
    cohort: "confirmed",
    highVol: true,
    cell: { trades: 40, expectancyPct: -1.6, winRatePct: 42.5 },
    age: {
      mult: 0.85,
      veto: false,
      ageBars: 2,
      band: {
        minAgeBars: 2,
        maxAgeBars: 3,
        mult: 0.85,
        veto: false,
        trades: 1084,
        expectancyPct: -0.29,
        label: "age 2-3 bars",
      },
      applies: true,
      reason: "not fresh",
    },
    applies: true,
    reason: "sideways tape",
    note: "confirmed breakout sideways/high-vol x0.50 (sideways tape)",
    ...over,
  };
}

describe("buildBreakoutDecisionAudit", () => {
  it("captures signal, expectancy cell, vol inputs and age band", () => {
    const a = buildBreakoutDecisionAudit({
      decision: decision(),
      breakout: evidence,
      regime: "range_bound",
      vix: 26.4,
      realisedVol20d: 0.017,
      tableSource: "refresh 2026-08",
      tableAsOf: "2026-08-09",
    });

    expect(a.action).toBe("downsize");
    expect(a.applied_multiplier).toBe(0.5);
    expect(a.raw_multiplier).toBe(1.2);
    expect(a.cohort).toBe("confirmed");
    expect(a.regime_bucket).toBe("sideways");
    expect(a.cell_trades).toBe(40);
    expect(a.cell_expectancy_pct).toBe(-1.6);
    expect(a.cell_verdict).toBe("proven negative");
    expect(a.vix).toBe(26.4);
    expect(a.realised_vol_20d).toBe(0.017);
    expect(a.high_vol).toBe(true);
    expect(a.age_bars).toBe(2);
    expect(a.age_band).toBe("age 2-3 bars");
    expect(a.quality).toBeCloseTo(0.72);
    expect(a.volume_ratio).toBeCloseTo(1.8);
    expect(a.table_source).toBe("refresh 2026-08");
    expect(a.reason).toBe("sideways tape");
  });

  it("explains a downsize with the size, reason, cell and vol read", () => {
    const a = buildBreakoutDecisionAudit({
      decision: decision(),
      breakout: evidence,
      regime: "range_bound",
      vix: 26.4,
      realisedVol20d: 0.017,
    });
    expect(a.explanation).toContain("Downsized to 50%");
    expect(a.explanation).toContain("sideways tape");
    expect(a.explanation).toContain("-1.60% per trade over 40 trades");
    expect(a.explanation).toContain("VIX 26.4");
    expect(a.explanation).toContain("high-vol");
    expect(a.explanation).toContain("2 bars old");
  });

  it("explains a skip and zeroes the multiplier", () => {
    const a = buildBreakoutDecisionAudit({
      decision: decision({ action: "skip", mult: 0, reason: "stale chase (age 4+)" }),
      breakout: evidence,
      regime: "bull",
      vix: 14,
      realisedVol20d: 0.008,
    });
    expect(a.applied_multiplier).toBe(0);
    expect(a.explanation.startsWith("Skipped: stale chase (age 4+)")).toBe(true);
  });

  it("marks non-breakout orders as not applicable", () => {
    const a = buildBreakoutDecisionAudit({
      decision: decision({
        applies: false,
        action: "trade",
        mult: 1,
        cohort: null,
        cell: null,
        reason: "not a breakout-driven trade",
      }),
      breakout: null,
      regime: "bull",
      vix: null,
      realisedVol20d: null,
    });
    expect(a.applies).toBe(false);
    expect(a.cell_verdict).toBe("no sample");
    expect(a.explanation).toContain("did not apply");
    expect(a.state).toBeNull();
  });

  it("classifies cells by sample size and sign", () => {
    expect(cellVerdict(null, 25, 0)).toBe("no sample");
    expect(cellVerdict({ trades: 10, expectancyPct: 3, winRatePct: 60 }, 25, 0)).toBe("unproven");
    expect(cellVerdict({ trades: 60, expectancyPct: 0.4, winRatePct: 55 }, 25, 0)).toBe("proven positive");
    expect(cellVerdict({ trades: 60, expectancyPct: -0.4, winRatePct: 45 }, 25, 0)).toBe("proven negative");
  });

  it("handles a missing expectancy cell in the explanation", () => {
    const base = buildBreakoutDecisionAudit({
      decision: decision({ cell: null, action: "trade", mult: 0.7, reason: "unproven cell" }),
      breakout: evidence,
      regime: "bull",
      vix: null,
      realisedVol20d: null,
    });
    expect(base.explanation).toContain("No measured history");
    expect(explainBreakoutDecision(base)).toBe(base.explanation);
  });
});
