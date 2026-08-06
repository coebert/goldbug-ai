// Company financials the engine reads before deciding on a stock.
//
// Every field here comes from publicly disclosed company information
// (reported accounts, filings-derived ratios, published analyst estimates and
// the company's own earnings calendar). Nothing is inferred from price alone —
// that is what the technical/alpha layer already does.

export type Fundamentals = {
  symbol: string;
  /** Quote currency of the listing (GBp for LSE pence quotes). */
  currency: string | null;
  /** Reporting currency of the accounts — often differs from the quote ccy. */
  financial_currency: string | null;

  // Size / valuation
  market_cap: number | null;
  trailing_pe: number | null;
  forward_pe: number | null;
  peg: number | null;
  price_to_book: number | null;
  ev_ebitda: number | null;
  ev_revenue: number | null;

  // Profitability
  gross_margin: number | null;
  operating_margin: number | null;
  profit_margin: number | null;
  return_on_equity: number | null;
  return_on_assets: number | null;

  // Growth
  revenue: number | null;
  revenue_growth: number | null;
  earnings_growth: number | null;
  eps_growth_next_q: number | null;
  eps_growth_next_y: number | null;
  trailing_eps: number | null;
  forward_eps: number | null;

  // Balance sheet / cash generation
  total_cash: number | null;
  total_debt: number | null;
  debt_to_equity: number | null; // percent, as reported (78.4 = 0.78x)
  current_ratio: number | null;
  quick_ratio: number | null;
  free_cashflow: number | null;
  operating_cashflow: number | null;

  // Shareholder returns / positioning
  dividend_yield: number | null;
  payout_ratio: number | null;
  beta: number | null;
  short_percent_float: number | null;

  // Published analyst consensus (public sell-side estimates)
  analyst_mean: number | null; // 1 = strong buy .. 5 = strong sell
  analyst_count: number | null;
  target_mean_price: number | null;
  current_price: number | null;
  rec_strong_buy: number | null;
  rec_buy: number | null;
  rec_hold: number | null;
  rec_sell: number | null;
  rec_strong_sell: number | null;

  /** Next scheduled results date (YYYY-MM-DD) when the company has published one. */
  next_earnings_date: string | null;

  /** Provider that supplied the row. */
  source: string;
  /** ISO timestamp of the fetch that produced this row. */
  fetched_at: string;
};

export type FundamentalsSubscores = {
  valuation: number | null;
  profitability: number | null;
  growth: number | null;
  balance_sheet: number | null;
  shareholder: number | null;
  analysts: number | null;
};

export type FundamentalsScore = {
  symbol: string;
  /** Bounded [-1, 1]; positive = financially attractive on published numbers. */
  score: number;
  subscores: FundamentalsSubscores;
  /** How many of the six pillars had data (0..6). */
  coverage: number;
  /** Hard financial risks worth vetoing or downsizing on. */
  flags: string[];
  /** One-line plain-English rationale for the prompt and the audit trail. */
  summary: string;
};

export const EMPTY_FUNDAMENTALS_SCORE = (symbol: string): FundamentalsScore => ({
  symbol,
  score: 0,
  subscores: {
    valuation: null,
    profitability: null,
    growth: null,
    balance_sheet: null,
    shareholder: null,
    analysts: null,
  },
  coverage: 0,
  flags: [],
  summary: "no published financials available",
});
