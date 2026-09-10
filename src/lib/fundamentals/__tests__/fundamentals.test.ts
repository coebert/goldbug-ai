import { describe, it, expect } from "vitest";
import { scoreFundamentals, financialFlags } from "../score";
import type { Fundamentals } from "../types";
import { formatCandidateTable } from "@/lib/trading-engine/features-prompt";
import { scoreQuality } from "@/lib/alpha/quality";

const base: Fundamentals = {
  symbol: "TEST",
  currency: "USD",
  financial_currency: "USD",
  market_cap: null,
  trailing_pe: null,
  forward_pe: null,
  peg: null,
  price_to_book: null,
  ev_ebitda: null,
  ev_revenue: null,
  gross_margin: null,
  operating_margin: null,
  profit_margin: null,
  return_on_equity: null,
  return_on_assets: null,
  revenue: null,
  revenue_growth: null,
  earnings_growth: null,
  eps_growth_next_q: null,
  eps_growth_next_y: null,
  trailing_eps: null,
  forward_eps: null,
  total_cash: null,
  total_debt: null,
  debt_to_equity: null,
  current_ratio: null,
  quick_ratio: null,
  free_cashflow: null,
  operating_cashflow: null,
  dividend_yield: null,
  payout_ratio: null,
  beta: null,
  short_percent_float: null,
  analyst_mean: null,
  analyst_count: null,
  target_mean_price: null,
  current_price: null,
  rec_strong_buy: null,
  rec_buy: null,
  rec_hold: null,
  rec_sell: null,
  rec_strong_sell: null,
  next_earnings_date: null,
  source: "test",
  fetched_at: "2026-08-06T00:00:00.000Z",
};

const healthy: Fundamentals = {
  ...base,
  symbol: "GOOD",
  market_cap: 100e9,
  trailing_pe: 14,
  forward_pe: 12,
  peg: 1,
  price_to_book: 2.5,
  ev_ebitda: 8,
  gross_margin: 0.52,
  operating_margin: 0.24,
  profit_margin: 0.18,
  return_on_equity: 0.25,
  return_on_assets: 0.12,
  revenue_growth: 0.14,
  earnings_growth: 0.22,
  eps_growth_next_y: 0.15,
  total_cash: 20e9,
  total_debt: 8e9,
  debt_to_equity: 30,
  current_ratio: 1.9,
  free_cashflow: 6e9,
  dividend_yield: 0.03,
  payout_ratio: 0.4,
  analyst_mean: 1.9,
  analyst_count: 20,
  target_mean_price: 120,
  current_price: 100,
};

const distressed: Fundamentals = {
  ...base,
  symbol: "BAD",
  market_cap: 2e9,
  trailing_pe: 90,
  forward_pe: 70,
  price_to_book: 15,
  ev_ebitda: 40,
  gross_margin: 0.08,
  operating_margin: -0.05,
  profit_margin: -0.12,
  return_on_equity: -0.2,
  return_on_assets: -0.06,
  revenue_growth: -0.18,
  earnings_growth: -0.4,
  total_cash: 0.2e9,
  total_debt: 5e9,
  debt_to_equity: 320,
  current_ratio: 0.6,
  free_cashflow: -0.4e9,
  dividend_yield: 0.09,
  payout_ratio: 1.6,
  short_percent_float: 0.22,
  analyst_mean: 4.1,
  analyst_count: 8,
  target_mean_price: 80,
  current_price: 100,
};

describe("scoreFundamentals", () => {
  it("rates a profitable, cheap, cash-generative company positively", () => {
    const s = scoreFundamentals(healthy, "2026-08-06");
    expect(s.score).toBeGreaterThan(0.3);
    expect(s.coverage).toBe(6);
    expect(s.flags).toEqual([]);
    expect(s.summary).toContain("P/E");
  });

  it("rates a loss-making, levered, expensive company negatively", () => {
    const s = scoreFundamentals(distressed, "2026-08-06");
    expect(s.score).toBeLessThan(-0.3);
    expect(s.flags).toContain("loss-making (negative net margin)");
    expect(s.flags).toContain("negative free cash flow");
    expect(s.flags.some((f) => f.startsWith("high leverage"))).toBe(true);
    expect(s.flags.some((f) => f.startsWith("dividend not covered"))).toBe(true);
  });

  it("ranks the healthy company above the distressed one", () => {
    expect(scoreFundamentals(healthy, "2026-08-06").score).toBeGreaterThan(
      scoreFundamentals(distressed, "2026-08-06").score,
    );
  });

  it("stays neutral with no disclosure rather than penalising the company", () => {
    const s = scoreFundamentals(base, "2026-08-06");
    expect(s.score).toBe(0);
    expect(s.coverage).toBe(0);
  });

  it("treats a missing row as unknown, not bad", () => {
    const s = scoreFundamentals(null, "2026-08-06", "NONE");
    expect(s.score).toBe(0);
    expect(s.summary).toMatch(/no published financials/);
  });

  it("never leaves the [-1, 1] band on extreme inputs", () => {
    const extreme = { ...distressed, trailing_pe: 5000, debt_to_equity: 9000, profit_margin: -50 };
    const s = scoreFundamentals(extreme, "2026-08-06");
    expect(s.score).toBeGreaterThanOrEqual(-1);
    expect(s.score).toBeLessThanOrEqual(1);
  });

  it("ignores negative-earnings P/E instead of reading it as cheap", () => {
    const negPe = { ...healthy, trailing_pe: -8, forward_pe: -6 };
    const s = scoreFundamentals(negPe, "2026-08-06");
    expect(s.subscores.valuation).not.toBeNull();
    expect(s.subscores.valuation!).toBeLessThan(
      scoreFundamentals(healthy, "2026-08-06").subscores.valuation!,
    );
  });

  it("is deterministic for the same inputs", () => {
    expect(scoreFundamentals(healthy, "2026-08-06")).toEqual(
      scoreFundamentals(healthy, "2026-08-06"),
    );
  });
});

describe("financialFlags", () => {
  it("flags imminent results within five days", () => {
    const f = { ...healthy, next_earnings_date: "2026-08-09" };
    expect(financialFlags(f, "2026-08-06")).toContain("results due in 3d");
  });

  it("does not flag results further out", () => {
    const f = { ...healthy, next_earnings_date: "2026-09-30" };
    expect(financialFlags(f, "2026-08-06").some((x) => x.startsWith("results due"))).toBe(false);
  });

  it("does not let an earnings date alone drag the score down", () => {
    const withDate = scoreFundamentals({ ...healthy, next_earnings_date: "2026-08-08" }, "2026-08-06");
    expect(withDate.score).toBe(scoreFundamentals(healthy, "2026-08-06").score);
  });
});

describe("candidate prompt table", () => {
  const row = (extra: Record<string, unknown>) => ({
    symbol: "GOOD",
    name: "Good Plc",
    asset_class: "stock",
    price: 100,
    news_contributors: 0,
    ...extra,
  });

  it("renders the financials block and its legend", () => {
    const table = formatCandidateTable([
      row({ fundamentals: healthy, fundamentals_score: scoreFundamentals(healthy, "2026-08-06") }),
    ]);
    expect(table).toContain("fund ");
    expect(table).toContain("published accounts");
    expect(table).toContain("pe:14");
    expect(table).toContain("roe:0.25");
    expect(table).toContain("rec:1.9/20");
  });

  it("surfaces disclosed red flags to the model", () => {
    const table = formatCandidateTable([
      row({
        symbol: "BAD",
        fundamentals: distressed,
        fundamentals_score: scoreFundamentals(distressed, "2026-08-06"),
      }),
    ]);
    expect(table).toContain("RISK:");
    expect(table).toContain("loss-making");
  });

  it("collapses to a dash for instruments with no accounts", () => {
    const table = formatCandidateTable([
      row({ symbol: "GLD", asset_class: "commodity", fundamentals: null, fundamentals_score: null }),
    ]);
    expect(table).toContain("fund -");
  });
});

describe("quality alpha with published financials", () => {
  const feature = {
    symbol: "GOOD",
    name: "Good Plc",
    asset_class: "stock",
    price: 100,
    sma20: null,
    sma50: null,
    rsi14: null,
    change5d: null,
    change30d: null,
    vol20d: 0.02,
    macd_hist: null,
    macd_bull_cross: false,
    macd_bear_cross: false,
    bb_width: 0.05,
    atr_pct: null,
    adv_20d: null,
    vw_momentum_10d: null,
    weekly_trend_up: false,
    weekly_rsi14: null,
    news_score: null,
    news_contributors: 0,
    news_momentum: null,
    cooling: false,
    rank_info: null,
  };

  it("lifts quality for strong reported accounts", () => {
    const good = scoreQuality({
      ...feature,
      fundamentals_score: { score: 0.8, coverage: 6, flags: [] },
    });
    const none = scoreQuality(feature);
    expect(good.score).toBeGreaterThan(none.score);
    expect(good.reason).toContain("financials");
  });

  it("pushes quality negative for distressed accounts", () => {
    const bad = scoreQuality({
      ...feature,
      fundamentals_score: { score: -0.8, coverage: 6, flags: ["loss-making (negative net margin)"] },
    });
    expect(bad.score).toBeLessThan(0);
    expect(bad.reason).toContain("loss-making");
  });

  it("falls back to the price proxy when no accounts exist", () => {
    expect(scoreQuality({ ...feature, fundamentals_score: null }).reason).toContain(
      "no published financials",
    );
  });
});
