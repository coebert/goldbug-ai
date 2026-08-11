import { describe, expect, it } from "vitest";
import { scoreCarry, DEFAULT_CASH_RATE } from "../carry";
import type { FeatureLike } from "../types";
import type { Fundamentals } from "@/lib/fundamentals/types";

const feature = (over: Partial<FeatureLike> = {}): FeatureLike => ({
  symbol: "TEST",
  name: "Test",
  asset_class: "stock",
  price: 100,
  sma20: null, sma50: null, rsi14: null,
  change5d: null, change30d: null, vol20d: 0.02,
  macd_hist: null, macd_bull_cross: false, macd_bear_cross: false,
  bb_width: null, atr_pct: null, adv_20d: null, vw_momentum_10d: null,
  weekly_trend_up: false, weekly_rsi14: null,
  news_score: null, news_contributors: 0, news_momentum: null,
  cooling: false, rank_info: null,
  ...over,
});

const fundamentals = (over: Partial<Fundamentals>): Fundamentals =>
  ({ symbol: "TEST", dividend_yield: null, payout_ratio: null, ...over }) as Fundamentals;

describe("carry model — published yield", () => {
  it("pays a covered yield well above the cash rate", () => {
    const s = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 0.07, payout_ratio: 0.5 }) }));
    expect(s.score).toBeGreaterThan(0.6);
    expect(s.reason).toContain("yield 7.0%");
  });

  it("scores a yield below the cash rate negatively", () => {
    const s = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 0.01 }) }));
    expect(s.score).toBeLessThan(0);
  });

  it("accepts percent-form yields from the provider", () => {
    const frac = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 0.06 }) })).score;
    const pct = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 6 }) })).score;
    expect(pct).toBeCloseTo(frac, 9);
  });

  it("punishes a payout earnings do not cover", () => {
    const covered = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 0.07, payout_ratio: 0.4 }) }));
    const uncovered = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 0.07, payout_ratio: 1.4 }) }));
    expect(uncovered.score).toBeLessThan(0);
    expect(uncovered.score).toBeLessThan(covered.score);
    expect(uncovered.reason).toContain("not covered");
  });

  it("treats a distress yield as a warning, not free money", () => {
    const fat = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 0.14, payout_ratio: 0.5 }) }));
    const healthy = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 0.07, payout_ratio: 0.5 }) }));
    expect(fat.score).toBeLessThan(healthy.score);
    expect(fat.reason).toContain("distress");
  });

  it("haircuts a stretched but covered payout", () => {
    const easy = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 0.08, payout_ratio: 0.4 }) }));
    const tight = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 0.08, payout_ratio: 0.9 }) }));
    expect(tight.score).toBeLessThan(easy.score);
    expect(tight.score).toBeGreaterThan(0);
  });

  it("uses the cash rate as the hurdle", () => {
    const f = feature({ fundamentals: fundamentals({ dividend_yield: DEFAULT_CASH_RATE }) });
    expect(scoreCarry(f).score).toBeCloseTo(0, 6);
    expect(scoreCarry(f, { cashRate: 0.01 }).score).toBeGreaterThan(0);
  });

  it("stays bounded in [-1, 1]", () => {
    const s = scoreCarry(feature({ fundamentals: fundamentals({ dividend_yield: 0.5, payout_ratio: 3 }) }));
    expect(s.score).toBeGreaterThanOrEqual(-1);
    expect(s.score).toBeLessThanOrEqual(1);
  });
});

describe("carry model — proxy fallback", () => {
  it("falls back to the price proxy with no published yield", () => {
    const s = scoreCarry(feature({ asset_class: "bond", vol20d: 0.005, change30d: 0.02 }));
    expect(s.score).toBeGreaterThan(0);
    expect(s.reason).toContain("proxy");
  });

  it("finds no carry edge in a jumpy equity", () => {
    const s = scoreCarry(feature({ vol20d: 0.06, change30d: 0.4 }));
    expect(s.score).toBeLessThanOrEqual(0);
  });

  it("ignores a zero or missing yield and uses the proxy", () => {
    const s = scoreCarry(feature({ asset_class: "cash", vol20d: 0.005, fundamentals: fundamentals({ dividend_yield: 0 }) }));
    expect(s.reason).toContain("proxy");
  });
});
