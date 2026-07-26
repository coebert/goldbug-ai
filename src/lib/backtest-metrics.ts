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
  method: "block" | "iid";
  blockLength: number;
};

/**
 * 95% bootstrap CIs for Sharpe and max drawdown.
 *
 * Default: MOVING-BLOCK bootstrap (contiguous blocks of length ~n^(1/3),
 * Politis–Romano) which preserves short-range autocorrelation in daily
 * returns. IID resampling systematically under-reports drawdown risk
 * because it destroys the clustering of losing days that produces deep
 * drawdowns in reality; block bootstrap keeps that clustering intact.
 *
 * Pass `{ method: "iid" }` to force the legacy IID behaviour.
 * Deterministic given `seed`.
 */
export function bootstrapCIs(
  returns: number[],
  opts: { samples?: number; seed?: number; method?: "block" | "iid"; blockLength?: number } = {},
): BootstrapCIs {
  const samples = Math.max(100, Math.floor(opts.samples ?? 1000));
  const seed = opts.seed ?? 0xC0FFEE;
  const method: "block" | "iid" = opts.method ?? "block";
  const n = returns.length;
  const defaultBlock = Math.max(1, Math.round(Math.pow(Math.max(n, 1), 1 / 3)));
  const blockLength = Math.max(1, Math.min(n || 1, Math.floor(opts.blockLength ?? defaultBlock)));
  if (n < 2) return { sharpe: null, maxDrawdown: null, method, blockLength };
  const rand = mulberry32(seed);
  const sharpes: number[] = new Array(samples);
  const mdds: number[] = new Array(samples);
  const resample: number[] = new Array(n);
  for (let i = 0; i < samples; i++) {
    if (method === "iid") {
      for (let j = 0; j < n; j++) resample[j] = returns[Math.floor(rand() * n)];
    } else {
      // Moving-block: pick a random start, copy `blockLength` contiguous
      // values, repeat until the resample is full. Wraps around the end
      // of the series (circular block variant) so every observation has
      // equal probability of being sampled.
      let j = 0;
      while (j < n) {
        const start = Math.floor(rand() * n);
        for (let k = 0; k < blockLength && j < n; k++, j++) {
          resample[j] = returns[(start + k) % n];
        }
      }
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
  return { sharpe: ci(sharpes), maxDrawdown: ci(mdds), method, blockLength };
}



/**
 * Annualised Sharpe ratio. Pass `rf` (annualised risk-free rate as a decimal,
 * e.g. 0.04 for 4%) to subtract the daily-equivalent rf before annualising.
 * Defaults to 0 for backwards compatibility with the portfolio dashboard.
 * The crypto backtest engine uses the same convention with an explicit rf.
 */
export function computeSharpe(returns: number[], rf = 0): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return 0;
  const dailyRf = rf / TRADING_DAYS_PER_YEAR;
  return ((mean - dailyRf) / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
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

export type PerAssetContribution = {
  symbol: string;
  realizedPnl: number;
  roundTrips: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  bought: number;      // cash outflow across all buys (qty*price)
  sold: number;        // cash inflow across all sells (qty*price)
  openQty: number;     // FIFO-remaining open quantity after replaying trades
  openCostBasis: number; // remaining open lots' cost basis (qty*avgLotPrice)
};

/**
 * Per-symbol contribution to strategy P&L: FIFO round-trip realized PnL,
 * win/loss counts, gross flows, and any open exposure left over after
 * replaying the trade log. Pure — no I/O, safe to run in the browser.
 */
export function perAssetContribution(trades: TradeRow[]): PerAssetContribution[] {
  const sorted = [...trades].sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date.localeCompare(b.trade_date);
    return (a.executed_at ?? "").localeCompare(b.executed_at ?? "");
  });
  type Agg = {
    lots: Lot[];
    realized: number;
    wins: number;
    losses: number;
    roundTrips: number;
    bought: number;
    sold: number;
  };
  const bySym = new Map<string, Agg>();
  const getAgg = (s: string): Agg => {
    let a = bySym.get(s);
    if (!a) {
      a = { lots: [], realized: 0, wins: 0, losses: 0, roundTrips: 0, bought: 0, sold: 0 };
      bySym.set(s, a);
    }
    return a;
  };
  for (const t of sorted) {
    const qty = Number(t.quantity);
    const price = Number(t.price);
    if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0) continue;
    const a = getAgg(t.symbol);
    if (t.side === "buy") {
      a.bought += qty * price;
      a.lots.push({ qty, price });
      continue;
    }
    a.sold += qty * price;
    let remaining = qty;
    let pnl = 0;
    while (remaining > 0 && a.lots.length > 0) {
      const lot = a.lots[0];
      const take = Math.min(lot.qty, remaining);
      pnl += (price - lot.price) * take;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-9) a.lots.shift();
    }
    if (remaining < qty) {
      a.realized += pnl;
      a.roundTrips += 1;
      if (pnl > 0) a.wins += 1;
      else if (pnl < 0) a.losses += 1;
    }
  }
  return Array.from(bySym.entries())
    .map(([symbol, a]) => {
      const openQty = a.lots.reduce((n, l) => n + l.qty, 0);
      const openCostBasis = a.lots.reduce((n, l) => n + l.qty * l.price, 0);
      return {
        symbol,
        realizedPnl: a.realized,
        roundTrips: a.roundTrips,
        wins: a.wins,
        losses: a.losses,
        winRatePct: a.roundTrips > 0 ? (a.wins / a.roundTrips) * 100 : null,
        bought: a.bought,
        sold: a.sold,
        openQty,
        openCostBasis,
      };
    })
    .sort((a, b) => b.realizedPnl - a.realizedPnl);
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
      sharpeCI: null,
      maxDrawdownCI: null,
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
  const cis = bootstrapCIs(rets);

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
    sharpeCI: cis.sharpe,
    maxDrawdownCI: cis.maxDrawdown,
  };
}
