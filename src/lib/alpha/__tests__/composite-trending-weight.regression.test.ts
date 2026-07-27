/**
 * Regression: the "trending" regime must render trend=71% in the alpha priors
 * prompt block. This locks in both the raw weight (0.60) and the strategy
 * gate matrix (mean_reversion + carry disabled in trending), whose combined
 * renormalization produces 0.60 / (0.60 + 0.25) ≈ 70.588% → "71%".
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

describe("composite: trending regime weight is pinned to 71%", () => {
  it("raw trending weights match the documented matrix (trend=0.60)", () => {
    // Guard against silent tweaks to the raw regime matrix. If a rebalance is
    // intentional, update this file *and* the prompt assertion together.
    const w = weightsForRegime("trending");
    expect(w).toEqual({
      trend: 0.60,
      mean_reversion: 0.10,
      quality: 0.25,
      carry: 0.05,
    });
  });

  it("trending gates mean_reversion + carry OFF, leaving trend + quality active", () => {
    const gates = enabledStrategiesForRegime("trending");
    expect(gates).toEqual({
      trend: true,
      mean_reversion: false,
      quality: true,
      carry: false,
    });
  });

  it("effective (gated + renormalised) trend weight rounds to 71%", () => {
    const eff = effectiveWeightsForRegime("trending");
    // 0.60 / (0.60 + 0.25) = 0.70588…
    expect(eff.trend).toBeCloseTo(0.60 / 0.85, 5);
    expect(Math.round(eff.trend * 100)).toBe(71);

    // Gated models must renormalise to exactly 0.
    expect(eff.mean_reversion).toBe(0);
    expect(eff.carry).toBe(0);

    // And the effective weights must still sum to 1.
    const sum = eff.trend + eff.mean_reversion + eff.quality + eff.carry;
    expect(sum).toBeCloseTo(1, 5);
  });

  it("formatAlphaPriorsForPrompt renders trend=71% for the trending regime", () => {
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
    expect(block).toContain("trend=71%");
    // Sanity: gated strategies should not be advertised with non-zero weight.
    expect(block).not.toMatch(/mean_reversion=(?!0%)\d+%/);
    expect(block).not.toMatch(/carry=(?!0%)\d+%/);
  });
});
