import { describe, expect, it } from "vitest";
import { evaluateRiskHalts } from "../risk-halts.server";

const thresholds = {
  max_position_pct: 0.75,
  max_daily_loss_pct: 0.05,
  max_drawdown_halt_pct: 0.2,
};

describe("risk halts — valuation trust", () => {
  it("suppresses the drawdown halt when most of the book had no quote", () => {
    // Reproduces the live incident: engine valued the book at 2,352 (holdings
    // priced off cost basis) while the broker NAV was 10,189 → phantom 76.9%.
    const s = evaluateRiskHalts({
      startingEquity: 1300.32,
      currentEquity: 2352.33,
      unpricedHoldingsValue: 1052.01,
      priorCloseEquity: 2177.53,
      peakEquity: 10189.12,
      thresholds,
    });
    expect(s.valuation_suspect).toBe(true);
    expect(s.drawdown_halt).toBe(false);
    expect(s.any_halt).toBe(false);
    expect(s.reason).toBeNull();
    // The measured number is still reported for diagnostics.
    expect(s.drawdown_pct).toBeCloseTo(0.7691, 3);
  });

  it("suppresses halts on an implausible single-step collapse vs prior close", () => {
    const s = evaluateRiskHalts({
      startingEquity: 10000,
      currentEquity: 2000,
      priorCloseEquity: 10000,
      peakEquity: 10000,
      thresholds,
    });
    expect(s.valuation_suspect).toBe(true);
    expect(s.any_halt).toBe(false);
  });

  it("still halts on a genuine, fully-priced drawdown", () => {
    const s = evaluateRiskHalts({
      startingEquity: 10000,
      currentEquity: 7500,
      unpricedHoldingsValue: 0,
      priorCloseEquity: 7600,
      peakEquity: 10000,
      thresholds,
    });
    expect(s.valuation_suspect).toBe(false);
    expect(s.drawdown_halt).toBe(true);
    expect(s.reason).toContain("drawdown");
  });

  it("still halts on a genuine daily loss", () => {
    const s = evaluateRiskHalts({
      startingEquity: 10000,
      currentEquity: 9000,
      priorCloseEquity: 10000,
      peakEquity: 10000,
      thresholds,
    });
    expect(s.daily_loss_halt).toBe(true);
    expect(s.valuation_suspect).toBe(false);
  });

  it("prefers the broker NAV over a derived valuation", () => {
    const s = evaluateRiskHalts({
      startingEquity: 1300.32,
      currentEquity: 2352.33,
      unpricedHoldingsValue: 1052.01,
      brokerEquity: 10189.12,
      priorCloseEquity: 10189.12,
      peakEquity: 10189.12,
      thresholds,
    });
    expect(s.valuation_source).toBe("broker");
    expect(s.valuation_suspect).toBe(false);
    expect(s.drawdown_pct).toBe(0);
    expect(s.any_halt).toBe(false);
    expect(s.inputs.current_equity).toBeCloseTo(10189.12, 2);
  });

  it("tolerates a small unpriced tail without distrusting the NAV", () => {
    const s = evaluateRiskHalts({
      startingEquity: 10000,
      currentEquity: 7500,
      unpricedHoldingsValue: 300, // 4% of NAV
      priorCloseEquity: 7600,
      peakEquity: 10000,
      thresholds,
    });
    expect(s.valuation_suspect).toBe(false);
    expect(s.drawdown_halt).toBe(true);
  });
});
