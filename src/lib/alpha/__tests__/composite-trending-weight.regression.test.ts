/**
 * Regression: the "trending" regime must render trend=55% in the alpha priors
 * prompt block. This locks in both the raw weight (0.48) and the strategy
 * gate matrix (mean_reversion + carry disabled in trending), whose combined
 * renormalization produces 0.48 / (0.48 + 0.20 + 0.20) ≈ 54.5% → "55%".
 *
 * If any of those inputs drift, this test fails loudly rather than letting
 * the prompt weight silently go stale (as happened previously when the raw
 * trend weight was bumped without updating downstream assertions).
 */
import { describe, it, expect } from "vitest";
import {
  weightsForRegime,
  enabledStrategiesForRegime,
  effectiveWeightsForRegime,
} from "../regime-matrix";
import { formatAlphaPriorsForPrompt, scoreCandidate } from "../composite";
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

describe("composite: trending regime weight is pinned to 55%", () => {
  it("raw trending weights match the documented matrix (trend=0.48)", () => {
    // Guard against silent tweaks to the raw regime matrix. If a rebalance is
    // intentional, update this file *and* the prompt assertion together.
    const w = weightsForRegime("trending");
    expect(w).toEqual({
      trend: 0.48,
      mean_reversion: 0.08,
      quality: 0.20,
      carry: 0.04,
      breakout: 0.20,
    });
  });

  it("trending gates mean_reversion + carry OFF, leaving trend + quality active", () => {
    const gates = enabledStrategiesForRegime("trending");
    expect(gates).toEqual({
      trend: true,
      mean_reversion: false,
      quality: true,
      carry: false,
      breakout: true,
    });
  });

  it("effective (gated + renormalised) trend weight rounds to 55%", () => {
    const eff = effectiveWeightsForRegime("trending");
    // 0.48 / (0.48 + 0.20 + 0.20) = 0.5454…
    expect(eff.trend).toBeCloseTo(0.48 / 0.88, 5);
    expect(Math.round(eff.trend * 100)).toBe(55);

    // Gated models must renormalise to exactly 0.
    expect(eff.mean_reversion).toBe(0);
    expect(eff.carry).toBe(0);

    // And the effective weights must still sum to 1.
    const sum = eff.trend + eff.mean_reversion + eff.quality + eff.carry + eff.breakout;
    expect(sum).toBeCloseTo(1, 5);
  });

  it("formatAlphaPriorsForPrompt renders trend=55% for the trending regime", () => {
    const scores = [
      scoreCandidate(
        baseFeature({
          symbol: "A", price: 110, sma20: 105, sma50: 100, change30d: 0.1,
          weekly_trend_up: true, weekly_rsi14: 60, macd_hist: 0.5,
        }),
        "trending",
      ),
    ];
    const block = formatAlphaPriorsForPrompt(scores, "trending", 5);
    expect(block).toContain("trend=55%");
    // Sanity: gated strategies should not be advertised with non-zero weight.
    expect(block).not.toMatch(/mean_reversion=(?!0%)\d+%/);
    expect(block).not.toMatch(/carry=(?!0%)\d+%/);
  });
});
