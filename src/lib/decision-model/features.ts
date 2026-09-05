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
  | "portfolio"
  | "events"
  | "sector"
  | "macro";


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
  // --- this account's own state ------------------------------------------
  // All read off a `pf` block injected by the dataset builder (history) or the
  // engine (live scoring). Missing => null => neutral after normalisation.
  {
    key: "pf_position_weight",
    label: "Existing position size (% of book)",
    bucket: "portfolio",
    extract: (r) => num(sub(r, "pf")?.["position_weight"]),
  },
  {
    key: "pf_unrealised_pct",
    label: "Unrealised P&L on the holding",
    bucket: "portfolio",
    extract: (r) => num(sub(r, "pf")?.["unrealised_pct"]),
  },
  {
    key: "pf_hold_days",
    label: "How long the name has been held",
    bucket: "portfolio",
    extract: (r) => {
      const v = num(sub(r, "pf")?.["hold_days"]);
      return v === null ? null : Math.min(v, 120) / 30;
    },
  },
  {
    key: "pf_loss_memory",
    label: "Recent realised loss on this name",
    bucket: "portfolio",
    extract: (r) => num(sub(r, "pf")?.["loss_memory"]),
  },
  {
    key: "pf_cash_weight",
    label: "Cash share of the book",
    bucket: "portfolio",
    extract: (r) => num(sub(r, "pf")?.["cash_weight"]),
  },
  {
    key: "pf_book_drawdown",
    label: "Book drawdown from peak",
    bucket: "portfolio",
    extract: (r) => num(sub(r, "pf")?.["book_drawdown"]),
  },
  // --- scheduled events / catalysts ---------------------------------------
  // Earnings dates come off the fundamentals block already attached to every
  // signal snapshot, so history and live scoring read the same field.
  {
    key: "earnings_proximity",
    label: "Closeness of the next earnings date",
    bucket: "events",
    extract: (r) => {
      const d = daysToEarnings(r);
      return d === null ? null : Math.exp(-Math.max(0, d) / 10);
    },
  },
  {
    key: "earnings_within_5d",
    label: "Reports within 5 trading days",
    bucket: "events",
    extract: (r) => {
      const d = daysToEarnings(r);
      return d === null ? null : d >= 0 && d <= 5 ? 1 : 0;
    },
  },
  {
    key: "event_score",
    label: "News-event score",
    bucket: "events",
    extract: (r) => num(sub(r, "event_features")?.["event_score"]),
  },
  {
    key: "event_pressure",
    label: "Event pressure",
    bucket: "events",
    extract: (r) => num(sub(r, "event_features")?.["event_pressure"]),
  },
  {
    key: "hard_catalyst",
    label: "Hard catalyst present",
    bucket: "events",
    extract: (r) => {
      const v = sub(r, "event_features")?.["hard_catalyst"];
      return v === undefined || v === null ? null : v === true ? 1 : 0;
    },
  },
  // --- sector context ------------------------------------------------------
  {
    key: "sector_momentum_30d",
    label: "Sector 30-day momentum",
    bucket: "sector",
    extract: (r) => num(sub(r, "sx")?.["momentum_30d"]),
  },
  {
    key: "sector_momentum_90d",
    label: "Sector 90-day momentum",
    bucket: "sector",
    extract: (r) => num(sub(r, "sx")?.["momentum_90d"]),
  },
  {
    key: "sector_rank",
    label: "Sector rank (best = +1)",
    bucket: "sector",
    extract: (r) => num(sub(r, "sx")?.["rank_norm"]),
  },
  {
    key: "sector_book_weight",
    label: "Share of the book already in this sector",
    bucket: "sector",
    extract: (r) => num(sub(r, "sx")?.["book_weight"]),
  },
  // --- market-wide (macro) backdrop ---------------------------------------
  {
    key: "macro_vix",
    label: "Volatility index level",
    bucket: "macro",
    extract: (r) => {
      const v = num(sub(r, "mx")?.["vix_level"]);
      return v === null ? null : v / 20 - 1;
    },
  },
  {
    key: "macro_spy_drawdown",
    label: "Market drawdown from peak",
    bucket: "macro",
    extract: (r) => num(sub(r, "mx")?.["spy_drawdown_pct"]),
  },
  {
    key: "macro_spy_over_sma200",
    label: "Market vs its 200-day average",
    bucket: "macro",
    extract: (r) => ratio(num(sub(r, "mx")?.["spy_price"]), num(sub(r, "mx")?.["spy_sma200"])),
  },
  {
    key: "macro_spy_return_30d",
    label: "Market 30-day return",
    bucket: "macro",
    extract: (r) => num(sub(r, "mx")?.["spy_return_30d"]),
  },
  {
    key: "macro_rates_30d",
    label: "Long bonds 30-day return",
    bucket: "macro",
    extract: (r) => num(sub(r, "mx")?.["tlt_return_30d"]),
  },
  {
    key: "macro_gold_30d",
    label: "Gold 30-day return",
    bucket: "macro",
    extract: (r) => num(sub(r, "mx")?.["gld_return_30d"]),
  },
  {
    key: "macro_risk_on",
    label: "Regime risk appetite",
    bucket: "macro",
    extract: (r) => num(sub(r, "mx")?.["risk_on"]),
  },
  {
    key: "beta_x_market_stress",
    label: "Beta into a falling market",
    bucket: "macro",
    extract: (r) => {
      const beta = num(sub(r, "fundamentals")?.["beta"]);
      const dd = num(sub(r, "mx")?.["spy_drawdown_pct"]);
      return beta === null || dd === null ? null : beta * dd;
    },
  },
] as const;

export const FEATURE_KEYS: readonly string[] = FEATURE_SPECS.map((f) => f.key);

export const BUCKETS: readonly SignalBucket[] = [
  "sma_trend",
  "rsi",
  "price_change",
  "news_sentiment",
  "volatility",
  "portfolio",
  "events",
  "sector",
  "macro",
];

/** Calendar days from the row's as-of date to the next scheduled earnings date. */
function daysToEarnings(row: AnyRow): number | null {
  const next = sub(row, "fundamentals")?.["next_earnings_date"];
  if (typeof next !== "string" || next.length < 10) return null;
  const asOf = typeof row["_asof"] === "string" ? (row["_asof"] as string) : null;
  const t0 = asOf ? Date.parse(asOf) : Date.now();
  const t1 = Date.parse(next.slice(0, 10));
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  const d = Math.round((t1 - t0) / 86_400_000);
  if (d < -30 || d > 200) return null;
  return d;
}

/** Sector context for one candidate row (same shape when fitting and scoring). */
export type SxContext = {
  momentum_30d: number | null;
  momentum_90d: number | null;
  /** +1 = best-ranked sector of the day, -1 = worst. */
  rank_norm: number | null;
  /** Share of the book already invested in this sector. */
  book_weight: number;
};

/** Market backdrop for one day (same shape when fitting and scoring). */
export type MxContext = {
  vix_level: number | null;
  spy_drawdown_pct: number | null;
  spy_price: number | null;
  spy_sma200: number | null;
  spy_return_30d: number | null;
  tlt_return_30d: number | null;
  gld_return_30d: number | null;
  /** +1 risk-on regime, -1 risk-off, 0 unknown/neutral. */
  risk_on: number | null;
};

export const NEUTRAL_SX: SxContext = {
  momentum_30d: null,
  momentum_90d: null,
  rank_norm: null,
  book_weight: 0,
};

export const NEUTRAL_MX: MxContext = {
  vix_level: null,
  spy_drawdown_pct: null,
  spy_price: null,
  spy_sma200: null,
  spy_return_30d: null,
  tlt_return_30d: null,
  gld_return_30d: null,
  risk_on: null,
};

/** Attach the day's market/sector context (and its date) to a signal row. */
export function withContext(
  row: AnyRow,
  ctx: { date?: string | null; sx?: SxContext | null; mx?: MxContext | null },
): AnyRow {
  return {
    ...row,
    ...(ctx.date ? { _asof: ctx.date } : {}),
    sx: ctx.sx ?? NEUTRAL_SX,
    mx: ctx.mx ?? NEUTRAL_MX,
  };
}

/** Map a regime label onto a risk-appetite number. */
export function regimeRiskOn(regime: string | null | undefined): number {
  const r = (regime ?? "").toLowerCase();
  if (!r) return 0;
  if (r.includes("bull")) return r.includes("volatile") ? 0.5 : 1;
  if (r.includes("bear")) return r.includes("quiet") ? -0.5 : -1;
  if (r.includes("crisis") || r.includes("panic")) return -1;
  return 0;
}

/**
 * The account-state block the portfolio features read. Built from history when
 * fitting and from the live book when scoring, so both paths see the same shape.
 */
export type PfContext = {
  /** Position value as a share of total book value (0 when not held). */
  position_weight: number;
  /** Unrealised P&L on the holding as a fraction of cost (0 when not held). */
  unrealised_pct: number;
  /** Calendar days the name has been held (0 when not held). */
  hold_days: number;
  /** Decayed realised loss on this name, as a fraction of book value (<= 0). */
  loss_memory: number;
  /** Cash share of the book on the day. */
  cash_weight: number;
  /** Book drawdown from its running peak (<= 0). */
  book_drawdown: number;
};

export const NEUTRAL_PF: PfContext = {
  position_weight: 0,
  unrealised_pct: 0,
  hold_days: 0,
  loss_memory: 0,
  cash_weight: 0,
  book_drawdown: 0,
};

/** Attach an account-state block to a signal/candidate row. */
export function withPf(row: AnyRow, pf: PfContext): AnyRow {
  return { ...row, pf };
}



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
