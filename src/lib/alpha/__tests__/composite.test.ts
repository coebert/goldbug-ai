import { describe, it, expect } from "vitest";
import { scoreTrend } from "../trend";
import { scoreMeanReversion } from "../mean-reversion";
import { scoreQuality } from "../quality";
import { scoreCarry } from "../carry";
import { scoreCandidate, formatAlphaPriorsForPrompt } from "../composite";
import { resolveRegime, weightsForRegime } from "../regime-matrix";
import type { FeatureLike } from "../types";

const baseFeature = (over: Partial<FeatureLike> = {}): FeatureLike => ({
  symbol: "TEST", name: "Test", asset_class: "equity",
  price: 100, sma20: 100, sma50: 100, rsi14: 50,
  change5d: 0, change30d: 0, vol20d: 0.02,
  macd_hist: 0, macd_bull_cross: false, macd_bear_cross: false,
  bb_width: 0.05, atr_pct: 0.02, adv_20d: 1_000_000,
  vw_momentum_10d: 0, weekly_trend_up: false, weekly_rsi14: 50,
  news_score: null, news_contributors: 0, news_momentum: null,
  cooling: false, rank_info: null,
  ...over,
});

describe("regime matrix", () => {
  it("resolves aliases and unknowns", () => {
    expect(resolveRegime("Risk On")).toBe("risk_on");
    expect(resolveRegime("bear")).toBe("risk_off");
    expect(resolveRegime(null)).toBe("unknown");
    expect(resolveRegime("nonsense")).toBe("unknown");
  });
  it("weights sum to 1 for every regime", () => {
    for (const r of ["risk_on","risk_off","high_vol","low_vol","trending","range_bound","unknown"]) {
      const w = weightsForRegime(r);
      const sum = w.trend + w.mean_reversion + w.quality + w.carry + w.breakout;
      expect(sum).toBeCloseTo(1, 5);
    }
  });
});

describe("alpha models — bounded output", () => {
  it("all model scores stay within [-1, 1]", () => {
    const extremes = [
      baseFeature({ change30d: 5, rsi14: 99, macd_hist: 10, atr_pct: 0.5, vw_momentum_10d: 5 }),
      baseFeature({ change30d: -5, rsi14: 1, macd_hist: -10, atr_pct: 0.5, vw_momentum_10d: -5 }),
    ];
    for (const f of extremes) {
      for (const s of [scoreTrend(f), scoreMeanReversion(f), scoreQuality(f), scoreCarry(f)]) {
        expect(s.score).toBeGreaterThanOrEqual(-1);
        expect(s.score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("trend model", () => {
  it("scores clean uptrend positive", () => {
    const s = scoreTrend(baseFeature({
      price: 110, sma20: 105, sma50: 100, change30d: 0.08,
      weekly_trend_up: true, weekly_rsi14: 60, macd_hist: 0.5, vw_momentum_10d: 0.05,
    }));
    expect(s.score).toBeGreaterThan(0.3);
  });
  it("penalises parabolic vol", () => {
    const calm = scoreTrend(baseFeature({
      price: 110, sma20: 105, sma50: 100, change30d: 0.1,
      weekly_trend_up: true, weekly_rsi14: 60, macd_hist: 0.5, atr_pct: 0.02,
    }));
    const wild = scoreTrend(baseFeature({
      price: 110, sma20: 105, sma50: 100, change30d: 0.1,
      weekly_trend_up: true, weekly_rsi14: 60, macd_hist: 0.5, atr_pct: 0.15,
    }));
    expect(wild.score).toBeLessThan(calm.score);
  });
});

describe("mean-reversion model", () => {
  it("rewards dip in uptrend", () => {
    const s = scoreMeanReversion(baseFeature({
      rsi14: 32, weekly_trend_up: true, sma20: 105, sma50: 100,
      change5d: -0.06, change30d: 0.05,
    }));
    expect(s.score).toBeGreaterThan(0.3);
  });
  it("avoids falling knife", () => {
    const s = scoreMeanReversion(baseFeature({
      rsi14: 20, weekly_trend_up: false, sma20: 95, sma50: 100,
      change5d: -0.09, change30d: -0.15,
    }));
    expect(s.score).toBeLessThan(0);
  });
});

describe("composite scoring", () => {
  it("risk_on tilts a trend name higher than risk_off does", () => {
    const f = baseFeature({
      price: 110, sma20: 105, sma50: 100, change30d: 0.08,
      weekly_trend_up: true, weekly_rsi14: 60, macd_hist: 0.5, vw_momentum_10d: 0.05,
    });
    const risky = scoreCandidate(f, "risk_on").composite;
    const defensive = scoreCandidate(f, "risk_off").composite;
    expect(risky).toBeGreaterThan(defensive);
  });
  it("risk_off boosts a low-vol carry-like name vs risk_on", () => {
    const f = baseFeature({
      asset_class: "bond", vol20d: 0.008, atr_pct: 0.008, change30d: 0.02,
    });
    const risky = scoreCandidate(f, "risk_on").composite;
    const defensive = scoreCandidate(f, "risk_off").composite;
    expect(defensive).toBeGreaterThan(risky);
  });
  it("prompt block includes regime weights + top longs", () => {
    const features = [
      baseFeature({ symbol: "A", price: 110, sma20: 105, sma50: 100, change30d: 0.1, weekly_trend_up: true, weekly_rsi14: 60, macd_hist: 0.5 }),
      baseFeature({ symbol: "B", change30d: -0.15, rsi14: 20, macd_bear_cross: true, weekly_trend_up: false }),
    ];
    const scores = features.map((f) => scoreCandidate(f, "trending"));
    const block = formatAlphaPriorsForPrompt(scores, "trending", 5);
    expect(block).toContain("ALPHA PRIORS");
    expect(block).toContain("trend=71%");
    expect(block).toContain("A ");
  });
});
