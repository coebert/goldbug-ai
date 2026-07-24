// Pure helpers to derive backtest key performance metrics from the
// data the app already stores:
//   • equity_snapshots (daily total_value points)
//   • trades           (buy/sell rows with symbol/qty/price)
//
// Metrics produced:
//   • totalReturnPct  — start-to-end equity change
//   • maxDrawdownPct  — worst peak-to-trough drop, as a NEGATIVE pct
//   • maxDrawdownPeakDate / troughDate
//   • sharpe          — annualised, rf = 0, ~252 trading days
//   • volatilityPct   — annualised stdev of daily returns
//   • winRatePct      — % of round-trip sells with realized PnL > 0
//   • wins / losses / trades — round-trip counts (closed lots only)
//   • avgWin / avgLoss / grossRealizedPnl
//   • bestDayPct / worstDayPct
//
// Win rate uses FIFO lot matching per symbol: each sell realized PnL =
// Σ (sellPrice − buyPrice) × matchedQty across the oldest open lots.
// Unmatched sells (short) are ignored — this app forbids leverage, so
// they shouldn't exist; if they do, they're excluded rather than
// treated as a win or loss on unknown cost basis.
//
// Pure module: no I/O. All inputs are plain arrays. Unit-testable.

export type EquityPoint = { snapshot_date: string; total_value: number };
export type TradeRow = {
  trade_date: string;
  executed_at?: string | null;
  side: "buy" | "sell";
  symbol: string;
  quantity: number;
  price: number;
};

export type ConfidenceInterval = {
  /** 2.5th percentile of the bootstrap distribution. */
  low: number;
  /** 50th percentile (median) of the bootstrap distribution. */
  median: number;
  /** 97.5th percentile of the bootstrap distribution. */
  high: number;
  /** Number of resamples used. */
  samples: number;
};

export type BacktestMetrics = {
  totalReturnPct: number;
  maxDrawdownPct: number;
  maxDrawdownPeakDate: string | null;
  maxDrawdownTroughDate: string | null;
  sharpe: number;
  volatilityPct: number;
  bestDayPct: number;
  worstDayPct: number;
  days: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  grossRealizedPnl: number;
  /** 95% bootstrap CI for annualised Sharpe. Null when < 2 daily returns. */
  sharpeCI: ConfidenceInterval | null;
  /** 95% bootstrap CI for max drawdown (negative %). Null when < 2 returns. */
  maxDrawdownCI: ConfidenceInterval | null;
};

const TRADING_DAYS_PER_YEAR = 252;

/**
 * Compute max drawdown as a NEGATIVE percentage (e.g. -12.5 for a 12.5%
 * peak-to-trough drop). Returns 0 when the curve never draws down.
 */
export function computeMaxDrawdown(values: EquityPoint[]): {
  pct: number;
  peakDate: string | null;
  troughDate: string | null;
} {
  if (values.length === 0) return { pct: 0, peakDate: null, troughDate: null };
  let peak = values[0].total_value;
  let peakDate = values[0].snapshot_date;
  let peakSince = peakDate;
  let worst = 0;
  let worstPeakDate: string | null = null;
  let worstTroughDate: string | null = null;
  for (const v of values) {
    if (v.total_value > peak) {
      peak = v.total_value;
      peakDate = v.snapshot_date;
      peakSince = v.snapshot_date;
    }
    if (peak > 0) {
      const dd = (v.total_value - peak) / peak; // ≤ 0
      if (dd < worst) {
        worst = dd;
        worstPeakDate = peakSince;
        worstTroughDate = v.snapshot_date;
      }
    }
  }
  return { pct: worst * 100, peakDate: worstPeakDate, troughDate: worstTroughDate };
}

/** Daily arithmetic returns from a sorted equity curve. */
export function dailyReturns(values: EquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1].total_value;
    if (prev > 0) out.push((values[i].total_value - prev) / prev);
  }
  return out;
}

/**
 * Deterministic PRNG (mulberry32). Same seed → same sequence, so
 * bootstrap CIs are reproducible across runs and platforms.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated percentile (0..100) of a sorted numeric array. */
function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Max drawdown (negative %) of a reconstructed equity path built from a
 * sequence of arithmetic returns, starting at 1.0. Used by the bootstrap.
 */
function maxDrawdownFromReturns(returns: number[]): number {
  if (returns.length === 0) return 0;
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = (equity - peak) / peak;
      if (dd < worst) worst = dd;
    }
  }
  return worst * 100;
}

export type BootstrapCIs = {
  sharpe: ConfidenceInterval | null;
  maxDrawdown: ConfidenceInterval | null;
};

/**
 * 95% bootstrap CIs for Sharpe and max drawdown, using stationary IID
 * resampling of daily returns with replacement. Deterministic given `seed`.
 *
 * Assumptions & caveats:
 *  • IID bootstrap: intraday autocorrelation is ignored. For daily equity
 *    curves this is the standard first-order approximation.
 *  • Max drawdown is path-dependent — we rebuild an equity path from each
 *    resample and measure MDD on it. Order within a resample matters, but
 *    across resamples the marginal distribution of returns is preserved.
 *  • Returns null when fewer than 2 daily returns exist (nothing to resample).
 */
export function bootstrapCIs(
  returns: number[],
  opts: { samples?: number; seed?: number } = {},
): BootstrapCIs {
  const samples = Math.max(100, Math.floor(opts.samples ?? 1000));
  const seed = opts.seed ?? 0xC0FFEE;
  if (returns.length < 2) return { sharpe: null, maxDrawdown: null };
  const rand = mulberry32(seed);
  const n = returns.length;
  const sharpes: number[] = new Array(samples);
  const mdds: number[] = new Array(samples);
  const resample: number[] = new Array(n);
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < n; j++) {
      resample[j] = returns[Math.floor(rand() * n)];
    }
    sharpes[i] = computeSharpe(resample);
    mdds[i] = maxDrawdownFromReturns(resample);
  }
  sharpes.sort((a, b) => a - b);
  mdds.sort((a, b) => a - b);
  const ci = (arr: number[]): ConfidenceInterval => ({
    low: percentileSorted(arr, 2.5),
    median: percentileSorted(arr, 50),
    high: percentileSorted(arr, 97.5),
    samples,
  });
  return { sharpe: ci(sharpes), maxDrawdown: ci(mdds) };

/** Annualised Sharpe ratio, rf = 0. Null when stdev is 0 or < 2 samples. */
export function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return 0;
  return (mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** Annualised volatility (stdev × √252) as a percentage. */
export function computeAnnualisedVolPct(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

type Lot = { qty: number; price: number };

/**
 * FIFO lot matcher: pairs each SELL with the oldest open BUY lots for
 * the same symbol and returns realized PnL per closed round-trip.
 * Unmatched sell quantity (no open lot) is skipped, not synthesised.
 */
export function realizedPnlPerRoundTrip(trades: TradeRow[]): number[] {
  const sorted = [...trades].sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date.localeCompare(b.trade_date);
    return (a.executed_at ?? "").localeCompare(b.executed_at ?? "");
  });
  const lots = new Map<string, Lot[]>();
  const roundTrips: number[] = [];
  for (const t of sorted) {
    const qty = Number(t.quantity);
    const price = Number(t.price);
    if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0) continue;
    const bucket = lots.get(t.symbol) ?? [];
    if (t.side === "buy") {
      bucket.push({ qty, price });
      lots.set(t.symbol, bucket);
      continue;
    }
    // sell: consume oldest lots first
    let remaining = qty;
    let pnl = 0;
    while (remaining > 0 && bucket.length > 0) {
      const lot = bucket[0];
      const take = Math.min(lot.qty, remaining);
      pnl += (price - lot.price) * take;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-9) bucket.shift();
    }
    lots.set(t.symbol, bucket);
    // Only count the portion that was actually matched to open lots.
    if (remaining < qty) roundTrips.push(pnl);
  }
  return roundTrips;
}

export function computeBacktestMetrics(
  equity: EquityPoint[],
  trades: TradeRow[],
  startingCash: number,
): BacktestMetrics {
  const values = equity
    .filter((e) => Number.isFinite(Number(e.total_value)))
    .map((e) => ({
      snapshot_date: e.snapshot_date,
      total_value: Number(e.total_value),
    }));

  if (values.length === 0) {
    return {
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      maxDrawdownPeakDate: null,
      maxDrawdownTroughDate: null,
      sharpe: 0,
      volatilityPct: 0,
      bestDayPct: 0,
      worstDayPct: 0,
      days: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      winRatePct: null,
      avgWin: null,
      avgLoss: null,
      grossRealizedPnl: 0,
    };
  }

  const finalValue = values[values.length - 1].total_value;
  const totalReturnPct =
    startingCash > 0 ? ((finalValue - startingCash) / startingCash) * 100 : 0;

  const dd = computeMaxDrawdown(values);
  const rets = dailyReturns(values);
  const sharpe = computeSharpe(rets);
  const volatilityPct = computeAnnualisedVolPct(rets);
  const bestDayPct = rets.length ? Math.max(...rets) * 100 : 0;
  const worstDayPct = rets.length ? Math.min(...rets) * 100 : 0;

  const roundTrips = realizedPnlPerRoundTrip(trades);
  const wins = roundTrips.filter((p) => p > 0);
  const losses = roundTrips.filter((p) => p < 0);
  const grossRealized = roundTrips.reduce((a, b) => a + b, 0);
  const winRatePct = roundTrips.length
    ? (wins.length / roundTrips.length) * 100
    : null;
  const avgWin = wins.length
    ? wins.reduce((a, b) => a + b, 0) / wins.length
    : null;
  const avgLoss = losses.length
    ? losses.reduce((a, b) => a + b, 0) / losses.length
    : null;

  return {
    totalReturnPct,
    maxDrawdownPct: dd.pct,
    maxDrawdownPeakDate: dd.peakDate,
    maxDrawdownTroughDate: dd.troughDate,
    sharpe,
    volatilityPct,
    bestDayPct,
    worstDayPct,
    days: values.length,
    trades: roundTrips.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct,
    avgWin,
    avgLoss,
    grossRealizedPnl: grossRealized,
  };
}
