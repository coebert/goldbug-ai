import { describe, expect, it } from "vitest";
import { qualityTolerance, scaleBonus, scaleTier } from "../quality-scale";
import { scoreFundamentals } from "../fundamentals/score";
import type { Fundamentals } from "../fundamentals/types";

const base = (over: Partial<Fundamentals>): Fundamentals =>
  ({
    symbol: "TEST",
    market_cap: null,
    trailing_pe: null,
    forward_pe: null,
    peg: null,
    price_to_book: null,
    ev_ebitda: null,
    gross_margin: null,
    operating_margin: null,
    profit_margin: null,
    return_on_equity: null,
    return_on_assets: null,
    revenue_growth: null,
    earnings_growth: null,
    eps_growth_next_q: null,
    eps_growth_next_y: null,
    debt_to_equity: null,
    total_cash: null,
    total_debt: null,
    free_cashflow: null,
    current_ratio: null,
    dividend_yield: null,
    payout_ratio: null,
    short_percent_float: null,
    analyst_mean: null,
    analyst_count: null,
    target_mean_price: null,
    current_price: null,
    next_earnings_date: null,
    ...over,
  }) as Fundamentals;

describe("scaleTier", () => {
  it("bands by market cap and returns null without data", () => {
    expect(scaleTier(300e9)).toBe("mega");
    expect(scaleTier(60e9)).toBe("large");
    expect(scaleTier(12e9)).toBe("mid");
    expect(scaleTier(3e9)).toBe("small");
    expect(scaleTier(5e8)).toBe("micro");
    expect(scaleTier(null)).toBeNull();
  });

  it("rewards size and penalises the very small, within bounds", () => {
    expect(scaleBonus(300e9)).toBeGreaterThan(scaleBonus(3e9));
    expect(Math.abs(scaleBonus(5e8))).toBeLessThanOrEqual(0.08);
    expect(scaleBonus(undefined)).toBe(0);
  });
});

describe("qualityTolerance", () => {
  it("is neutral with no disclosure", () => {
    expect(qualityTolerance({})).toBe(1);
  });

  it("widens for profitable, growing, cash-generative businesses", () => {
    const t = qualityTolerance({
      return_on_equity: 0.35,
      profit_margin: 0.25,
      revenue_growth: 0.22,
      free_cashflow: 6e9,
      market_cap: 100e9,
    });
    expect(t).toBeGreaterThan(1.3);
    expect(t).toBeLessThanOrEqual(1.6);
  });

  it("tightens for shrinking, cash-burning businesses", () => {
    expect(
      qualityTolerance({ revenue_growth: -0.1, free_cashflow: -1e8, market_cap: 1e9 }),
    ).toBeLessThan(1);
  });
});

describe("scoreFundamentals scale and quality tilt", () => {
  it("marks a high-multiple compounder down less than a low-quality name", () => {
    const good = scoreFundamentals(
      base({
        trailing_pe: 55,
        return_on_equity: 0.35,
        profit_margin: 0.25,
        revenue_growth: 0.2,
        free_cashflow: 6e9,
        market_cap: 300e9,
      }),
      "2026-09-10",
    );
    const poor = scoreFundamentals(
      base({
        trailing_pe: 55,
        return_on_equity: 0.03,
        profit_margin: 0.01,
        revenue_growth: -0.05,
        market_cap: 1e9,
      }),
      "2026-09-10",
    );
    expect(good.score).toBeGreaterThan(poor.score);
    expect(good.flags.join(" ")).not.toContain("stretched valuation");
  });

  it("still flags a stretched multiple on an ordinary business", () => {
    const s = scoreFundamentals(
      base({ trailing_pe: 80, profit_margin: 0.02, market_cap: 5e9 }),
      "2026-09-10",
    );
    expect(s.flags.join(" ")).toContain("stretched valuation");
  });
});
