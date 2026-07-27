import { describe, it, expect } from "vitest";
import {
  averageDailyNotional,
  realizedDailyVol,
  deriveTuning,
  inferCurrency,
} from "@/lib/execution-calibration.server";
import { DEFAULT_TUNING } from "@/lib/spread-slippage";

function synthBars(n: number, price: number, dailyRet: number, volume: number) {
  const bars = [];
  let p = price;
  for (let i = 0; i < n; i += 1) {
    const open = p;
    const close = p * (1 + dailyRet);
    const high = Math.max(open, close) * 1.005;
    const low = Math.min(open, close) * 0.995;
    bars.push({
      date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`,
      open, high, low, close, volume,
    });
    p = close;
  }
  return bars;
}

describe("execution calibration primitives", () => {
  it("averageDailyNotional multiplies close × volume", () => {
    const bars = synthBars(25, 100, 0, 10_000);
    const adv = averageDailyNotional(bars, 20);
    expect(adv).toBeCloseTo(100 * 10_000, 0);
  });

  it("realizedDailyVol matches log-return stdev magnitude", () => {
    const bars = synthBars(70, 100, 0.01, 1_000);
    const rv = realizedDailyVol(bars, 60);
    // constant daily return of 1% → zero variance
    expect(rv).not.toBeNull();
    expect(rv!).toBeLessThan(1e-9);
  });

  it("inferCurrency picks GBP for .L, EUR for .DE, USD default", () => {
    expect(inferCurrency("VOD.L")).toBe("GBP");
    expect(inferCurrency("BTCE.DE")).toBe("EUR");
    expect(inferCurrency("AAPL")).toBe("USD");
  });
});

describe("deriveTuning", () => {
  it("keeps defaults when spread/ATR sample is missing", () => {
    const { tuning } = deriveTuning({
      assetClass: "stock",
      currency: "USD",
      atrPct: null,
      spreadPct: null,
      advNotional20d: null,
    });
    expect(tuning.vol_widening_coeff_bps).toBe(DEFAULT_TUNING.vol_widening_coeff_bps);
    // No ADV → default impact multiplier of 1
    expect(tuning.impact_coeff).toBeCloseTo(DEFAULT_TUNING.impact_coeff, 5);
  });

  it("tightens impact_coeff for deep-liquidity names", () => {
    const deep = deriveTuning({
      assetClass: "etf",
      currency: "USD",
      atrPct: 0.01,
      spreadPct: 0.0002, // 2bps round-trip
      advNotional20d: 5e9, // $5B/day, e.g. SPY-class
    });
    const shallow = deriveTuning({
      assetClass: "stock",
      currency: "GBP",
      atrPct: 0.03,
      spreadPct: 0.005,
      advNotional20d: 5e5, // $500k/day small-cap
    });
    expect(deep.tuning.impact_coeff).toBeLessThan(DEFAULT_TUNING.impact_coeff);
    expect(shallow.tuning.impact_coeff).toBeGreaterThan(DEFAULT_TUNING.impact_coeff);
  });

  it("clamps derived vol_widening_coeff_bps into a sane range", () => {
    // Absurdly wide spread relative to ATR — must not blow up.
    const { tuning } = deriveTuning({
      assetClass: "stock",
      currency: "USD",
      atrPct: 0.001,
      spreadPct: 0.5,
      advNotional20d: 1e8,
    });
    expect(tuning.vol_widening_coeff_bps).toBeGreaterThanOrEqual(0);
    expect(tuning.vol_widening_coeff_bps).toBeLessThanOrEqual(400);
  });

  it("widens the max impact cap for illiquid names", () => {
    const { tuning } = deriveTuning({
      assetClass: "stock",
      currency: "USD",
      atrPct: 0.03,
      spreadPct: 0.008,
      advNotional20d: 2e5,
    });
    expect(tuning.max_impact_bps).toBeGreaterThan(DEFAULT_TUNING.max_impact_bps);
  });
});
