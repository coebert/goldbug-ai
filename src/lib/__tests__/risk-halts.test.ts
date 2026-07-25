import { describe, it, expect } from "vitest";
import { evaluateRiskHalts, type HaltThresholds } from "@/lib/risk-halts.server";

const T: HaltThresholds = {
  max_position_pct: 0.2,
  max_daily_loss_pct: 0.03,       // 3% daily
  max_drawdown_halt_pct: 0.15,    // 15% peak-to-trough
};

describe("evaluateRiskHalts", () => {
  it("returns no halts when equity is flat and no snapshots yet", () => {
    const r = evaluateRiskHalts({
      startingEquity: 1000,
      currentEquity: 1000,
      priorCloseEquity: null,
      peakEquity: null,
      thresholds: T,
    });
    expect(r.any_halt).toBe(false);
    expect(r.drawdown_pct).toBe(0);
    expect(r.daily_loss_pct).toBe(0);
  });

  it("halts trading when today's loss exceeds the daily cap", () => {
    const r = evaluateRiskHalts({
      startingEquity: 1000,
      currentEquity: 960,          // -4% vs prior close
      priorCloseEquity: 1000,
      peakEquity: 1000,
      thresholds: T,
    });
    expect(r.daily_loss_halt).toBe(true);
    expect(r.drawdown_halt).toBe(false);
    expect(r.any_halt).toBe(true);
    expect(r.reason).toMatch(/daily loss/i);
  });

  it("does not halt on a shallow intraday dip inside the daily cap", () => {
    const r = evaluateRiskHalts({
      startingEquity: 1000,
      currentEquity: 985,          // -1.5%
      priorCloseEquity: 1000,
      peakEquity: 1000,
      thresholds: T,
    });
    expect(r.daily_loss_halt).toBe(false);
  });

  it("halts when peak-to-current drawdown exceeds the drawdown cap", () => {
    const r = evaluateRiskHalts({
      startingEquity: 1000,
      currentEquity: 800,          // -20% from 1000 peak
      priorCloseEquity: 810,
      peakEquity: 1000,
      thresholds: T,
    });
    expect(r.drawdown_halt).toBe(true);
    expect(r.reason).toMatch(/drawdown/i);
  });

  it("treats a zero threshold as disabled", () => {
    const r = evaluateRiskHalts({
      startingEquity: 1000,
      currentEquity: 500,
      priorCloseEquity: 900,
      peakEquity: 1000,
      thresholds: { ...T, max_daily_loss_pct: 0, max_drawdown_halt_pct: 0 },
    });
    expect(r.any_halt).toBe(false);
  });

  it("uses starting equity as fallback denominator when no prior close exists", () => {
    const r = evaluateRiskHalts({
      startingEquity: 1000,
      currentEquity: 940,          // -6% vs starting
      priorCloseEquity: null,
      peakEquity: null,
      thresholds: T,
    });
    expect(r.daily_loss_halt).toBe(true);
  });

  it("counts an equity peak above starting equity toward drawdown", () => {
    const r = evaluateRiskHalts({
      startingEquity: 1000,
      currentEquity: 1020,         // above start but well below peak
      priorCloseEquity: 1030,
      peakEquity: 1200,            // 15% peak-to-current exactly
      thresholds: T,
    });
    expect(r.drawdown_pct).toBeCloseTo(0.15, 5);
    expect(r.drawdown_halt).toBe(true);
  });

  it("both halts can trip together", () => {
    const r = evaluateRiskHalts({
      startingEquity: 1000,
      currentEquity: 700,
      priorCloseEquity: 800,
      peakEquity: 1000,
      thresholds: T,
    });
    expect(r.daily_loss_halt).toBe(true);
    expect(r.drawdown_halt).toBe(true);
    expect(r.reason).toMatch(/daily loss.*drawdown/i);
  });
});
