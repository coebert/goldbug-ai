/**
 * Feature extraction for the learned decision model.
 *
 * Every daily tick already stores a full per-symbol signal snapshot on
 * `decisions.raw.signals`. That is the exact information the AI saw on the
 * day, so it is also the honest training input: no look-ahead, no re-derived
 * indicators, just the account's own history replayed.
 *
 * This module is pure so it can be used both when fitting (historical rows)
 * and when scoring (today's candidate rows).
 */

/**
 * The five buckets the AI already attributes its own orders across, plus a
 * sixth for the state of THIS account (position size, cash, drawdown, past
 * losses on the name) — the part that makes the fit portfolio-specific rather
 * than a generic cross-sectional signal study.
 */
export type SignalBucket =
  | "sma_trend"
  | "rsi"
  | "price_change"
  | "news_sentiment"
  | "volatility"
  | "portfolio";


export type FeatureSpec = {
  key: string;
  label: string;
  bucket: SignalBucket;
  /** Pull the raw (un-normalised) value out of a signal/candidate row. */
  extract: (row: AnyRow) => number | null;
};

export type AnyRow = Record<string, unknown>;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

function sub(row: AnyRow, key: string): AnyRow | null {
  const v = row[key];
  return v && typeof v === "object" ? (v as AnyRow) : null;
}

function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return a / b - 1;
}

export const FEATURE_SPECS: readonly FeatureSpec[] = [
  // --- trend / moving averages -------------------------------------------
  {
    key: "px_over_sma20",
    label: "Price vs 20-day average",
    bucket: "sma_trend",
    extract: (r) => ratio(num(r["price"]), num(r["sma20"])),
  },
  {
    key: "sma20_over_sma50",
    label: "20-day vs 50-day average",
    bucket: "sma_trend",
    extract: (r) => ratio(num(r["sma20"]), num(r["sma50"])),
  },
  {
    key: "px_over_sma200",
    label: "Price vs 200-day average",
    bucket: "sma_trend",
    extract: (r) => ratio(num(r["price"]), num(r["sma200"])),
  },
  {
    key: "macd_norm",
    label: "MACD histogram (price-normalised)",
    bucket: "sma_trend",
    extract: (r) => {
      const m = num(r["macd_hist"]);
      const p = num(r["price"]);
      return m === null || p === null || p === 0 ? null : m / p;
    },
  },
  {
    key: "trend_z",
    label: "Cross-sectional trend rank",
    bucket: "sma_trend",
    extract: (r) => num(sub(r, "rank_info")?.["trend_z"]),
  },
  // --- oscillators --------------------------------------------------------
  {
    key: "rsi14",
    label: "Daily RSI-14 (centred)",
    bucket: "rsi",
    extract: (r) => {
      const v = num(r["rsi14"]);
      return v === null ? null : (v - 50) / 50;
    },
  },
  {
    key: "rsi_weekly",
    label: "Weekly RSI-14 (centred)",
    bucket: "rsi",
    extract: (r) => {
      const v = num(r["weekly_rsi14"]);
      return v === null ? null : (v - 50) / 50;
    },
  },
  {
    key: "stoch_k",
    label: "Stochastic %K (centred)",
    bucket: "rsi",
    extract: (r) => {
      const v = num(sub(r, "stochastic")?.["k"]);
      return v === null ? null : (v - 50) / 50;
    },
  },
  // --- price momentum -----------------------------------------------------
  {
    key: "change5d",
    label: "5-day price change",
    bucket: "price_change",
    extract: (r) => num(r["change5d"]),
  },
  {
    key: "change30d",
    label: "30-day price change",
    bucket: "price_change",
    extract: (r) => num(r["change30d"]),
  },
  {
    key: "momentum_z",
    label: "Cross-sectional momentum rank",
    bucket: "price_change",
    extract: (r) => num(sub(r, "rank_info")?.["momentum_z"]),
  },
  {
    key: "breakout_quality",
    label: "Breakout quality",
    bucket: "price_change",
    extract: (r) => num(sub(r, "breakout")?.["quality"]),
  },
  // --- news / sentiment ---------------------------------------------------
  {
    key: "news_score",
    label: "News sentiment",
    bucket: "news_sentiment",
    extract: (r) => num(r["news_score"]),
  },
  {
    key: "news_delta_3d",
    label: "3-day sentiment change",
    bucket: "news_sentiment",
    extract: (r) => num(sub(r, "news_momentum")?.["delta_3d"]),
  },
  {
    key: "news_accel",
    label: "Sentiment acceleration",
    bucket: "news_sentiment",
    extract: (r) => num(sub(r, "news_momentum")?.["accel"]),
  },
  // --- volatility / risk --------------------------------------------------
  {
    key: "vol20d",
    label: "20-day volatility",
    bucket: "volatility",
    extract: (r) => num(r["vol20d"]),
  },
  {
    key: "atr_pct",
    label: "ATR %",
    bucket: "volatility",
    extract: (r) => num(r["atr_pct"]),
  },
  {
    key: "bb_width",
    label: "Bollinger width",
    bucket: "volatility",
    extract: (r) => num(r["bb_width"]),
  },
  {
    key: "low_vol_z",
    label: "Cross-sectional low-vol rank",
    bucket: "volatility",
    extract: (r) => num(sub(r, "rank_info")?.["low_vol_z"]),
  },
] as const;

export const FEATURE_KEYS: readonly string[] = FEATURE_SPECS.map((f) => f.key);

export const BUCKETS: readonly SignalBucket[] = [
  "sma_trend",
  "rsi",
  "price_change",
  "news_sentiment",
  "volatility",
];

/** Raw (un-normalised) feature vector for one symbol on one date. */
export function extractFeatureVector(row: AnyRow): Array<number | null> {
  return FEATURE_SPECS.map((spec) => {
    try {
      return spec.extract(row);
    } catch {
      return null;
    }
  });
}

export function bucketOf(key: string): SignalBucket | null {
  return FEATURE_SPECS.find((f) => f.key === key)?.bucket ?? null;
}

export function labelOf(key: string): string {
  return FEATURE_SPECS.find((f) => f.key === key)?.label ?? key;
}
