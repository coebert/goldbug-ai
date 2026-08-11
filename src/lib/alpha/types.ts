// Shared types for the systematic-alpha layer.
// Each model consumes the same FeatureLike shape produced by
// buildCandidateFeatures() in trading-engine.server.ts and returns a
// bounded [-1, 1] score plus a short human-readable rationale.

export type FeatureLike = {
  symbol: string;
  name: string;
  asset_class: string;
  price: number;
  sma20: number | null;
  sma50: number | null;
  /** 200-day simple moving average; null until 200 candles exist. */
  sma200?: number | null;
  rsi14: number | null;
  change5d: number | null;
  change30d: number | null;
  vol20d: number | null;
  macd_hist: number | null;
  macd_bull_cross: boolean;
  macd_bear_cross: boolean;
  bb_width: number | null;
  atr_pct: number | null;
  adv_20d: number | null;
  vw_momentum_10d: number | null;
  weekly_trend_up: boolean;
  weekly_rsi14: number | null;
  /**
   * Stochastic oscillator (14/3/3) used for entry timing — see
   * src/lib/signals-extended.server.ts. Null when history is too short.
   */
  stochastic?: {
    k: number;
    d: number;
    oversold: boolean;
    overbought: boolean;
    bull_cross: boolean;
    bear_cross: boolean;
    bull_cross_from_oversold: boolean;
    rising: boolean;
  } | null;
  /** SMA20/50 + SMA50/200 crossover state (see alpha/sma-cross-rules). */
  sma_cross?: import("./sma-cross-rules").SmaCrossState | null;
  news_score: number | null;
  news_contributors: number;
  news_momentum: unknown | null;
  cooling: boolean;
  rank_info: { percentile?: number | null } | null;
  /**
   * Score derived from the company's published financials (see
   * src/lib/fundamentals). Null for instruments with no accounts — ETFs,
   * commodities, FX and crypto — and for companies the provider does not cover.
   */
  fundamentals_score?: {
    score: number;
    coverage: number;
    flags?: string[];
  } | null;
  /**
   * Range-breakout evidence computed from daily candles in
   * buildCandidateFeatures(). Null when history is too short.
   */
  breakout?: import("./breakout").BreakoutEvidence | null;
};

export type AlphaModelKind = "trend" | "mean_reversion" | "quality" | "carry" | "breakout";

export type AlphaScore = {
  symbol: string;
  kind: AlphaModelKind;
  score: number; // bounded [-1, 1]; positive = long bias, negative = avoid/short
  reason: string;
};

export type CompositeScore = {
  symbol: string;
  composite: number; // bounded [-1, 1]
  perModel: Partial<Record<AlphaModelKind, number>>;
  top_driver: AlphaModelKind | null;
  reason: string;
};

// Clamp helper — all models must return values in [-1, 1].
export const clamp1 = (x: number): number =>
  Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
