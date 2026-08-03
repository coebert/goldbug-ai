// Decision/signal row shapes rendered by the portfolio detail route.
// Extracted from src/routes/portfolio.$id.tsx (shapes unchanged).

export type SignalRow = {
  symbol: string;
  name: string;
  asset_class: string;
  price: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  change5d: number | null;
  change30d: number | null;
};

export type ExecutedLiquidity = {
  adv_20d_usd: number | null;
  atr_pct: number | null;
  spread_bps: number | null;
  est_slippage_bps: number;
  est_turnover_pct_adv: number | null;
  liquidity_cap_spend: number | null;
  trim_fraction: number;
  rejection_score: number;
  rejection_bucket: "low" | "medium" | "high";
};

export type ExecutedRow = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  value: number;
  reason: string;
  rejected?: string;
  liquidity?: ExecutedLiquidity;
};

export type NewsRow = {
  headline: string;
  source: string | null;
  sentiment?: number | null;
  source_weight?: number | null;
};

export type Guardrails = {
  risk_level: string;
  max_position_pct: number;
  cash_floor_pct: number;
  max_new_positions_per_day: number;
  cash_floor_value: number;
  max_position_value: number;
  starting_total_value: number;
  starting_cash: number;
};

export type SignalWeights = {
  sma_trend: number;
  rsi: number;
  price_change: number;
  news_sentiment: number;
  volatility: number;
};

export type AiOrder = {
  symbol?: string;
  side?: "buy" | "sell";
  conviction?: number | null;
  signal_weights?: Partial<SignalWeights>;
};

export type DecisionRaw = {
  orders?: AiOrder[];
  executed?: ExecutedRow[];
  signals?: SignalRow[];
  news?: NewsRow[];
  guardrails?: Guardrails;
  plain_explanation?: {
    text?: string | null;
    model?: string | null;
    category?: "traded" | "held_cash" | "halted" | "no_signal";
  } | null;
};
