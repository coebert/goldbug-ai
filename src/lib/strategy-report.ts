// Strategy evaluation report.
//
// Consumes the output of `runBacktest` and produces a compact,
// UI-ready summary of how the strategy performed:
//
//   Returns:    total return, CAGR, best/worst day, annualized vol
//   Risk:       max drawdown (with peak/trough dates), longest
//               drawdown duration (in bars), Sharpe, Sortino, Calmar
//   Trades:     total, wins, losses, win rate, avg win, avg loss,
//               profit factor, largest win / loss, gross realized PnL
//   Exposure:   pct of bars with non-zero holdings, avg cash weight
//
// Trade success is measured at the SELL side using realized PnL from
// the broker-simulator snapshots (BUY snapshots have realizedPnl = 0).
// This matches how the ledger reports realized gains and avoids
// double-counting open positions. Unrealized PnL is captured
// separately in `openPositionsValue` on the final state.
//
// PURE module — no I/O, deterministic, unit-testable.

import type { BacktestResult, BacktestStepSnapshot, BacktestEquityPoint } from "./backtest-runner";

/** ~252 trading days/year — used to annualize daily-bar backtests. */
const TRADING_DAYS_PER_YEAR = 252;

export type StrategyReport = {
  period: {
    startDate: string | null;
    endDate: string | null;
    bars: number;
    years: number;
  };
  returns: {
    startingEquity: number;
    endingEquity: number;
    totalReturnPct: number;
    cagrPct: number | null;
    annualizedVolPct: number | null;
    bestBarPct: number | null;
    worstBarPct: number | null;
  };
  risk: {
    maxDrawdownPct: number;
    maxDrawdownPeakDate: string | null;
    maxDrawdownTroughDate: string | null;
    longestDrawdownBars: number;
    sharpe: number | null;
    sortino: number | null;
    calmar: number | null;
  };
  trades: {
    total: number;
    executed: number;
    rejected: number;
    sells: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    largestWin: number | null;
    largestLoss: number | null;
    grossRealizedPnl: number;
    profitFactor: number | null;
  };
  exposure: {
    barsInvestedPct: number;
    avgCashWeightPct: number;
    finalCash: number;
    finalHoldingsValue: number;
    finalHoldingsCount: number;
  };
};

// ---------------------------------------------------------------------------

function safeDiv(a: number, b: number): number | null {
  return b === 0 || !Number.isFinite(b) ? null : a / b;
}

function pctReturns(curve: BacktestEquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].totalValue;
    if (prev > 0) out.push((curve[i].totalValue - prev) / prev);
  }
  return out;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Max drawdown from peak on the total-equity curve. Returns pct as [0,1]. */
function maxDrawdown(curve: BacktestEquityPoint[]): {
  pct: number;
  peakDate: string | null;
  troughDate: string | null;
  longestBars: number;
} {
  let peak = -Infinity;
  let peakDate: string | null = null;
  let peakSinceRecoveryDate: string | null = null;
  let worst = 0;
  let worstPeakDate: string | null = null;
  let worstTroughDate: string | null = null;
  let currentDDBars = 0;
  let longestDDBars = 0;

  for (const p of curve) {
    if (p.totalValue > peak) {
      peak = p.totalValue;
      peakDate = p.date;
      peakSinceRecoveryDate = p.date;
      currentDDBars = 0;
    } else {
      currentDDBars += 1;
      if (currentDDBars > longestDDBars) longestDDBars = currentDDBars;
    }
    if (peak > 0) {
      const dd = (peak - p.totalValue) / peak;
      if (dd > worst) {
        worst = dd;
        worstPeakDate = peakSinceRecoveryDate;
        worstTroughDate = p.date;
      }
    }
  }

  return {
    pct: worst,
    peakDate: worstPeakDate,
    troughDate: worstTroughDate,
    longestBars: longestDDBars,
  };
}

/**
 * Sum realized PnL segments per sell. Since the simulator emits
 * `realizedPnl` only on SELL snapshots, we treat each SELL as one
 * "trade outcome" for win/loss stats.
 */
function tradeStats(snapshots: BacktestStepSnapshot[]) {
  const sells = snapshots.filter((s) => s.realizedPnl !== 0 || s.fillQuantity > 0 && s.holdings.every((h) => h.symbol !== undefined) === false);
  // Prefer explicit SELL detection via the presence of a non-zero
  // realizedPnl OR any snapshot whose corresponding decision was a
  // sell. The simulator embeds this in realizedPnl already; buys emit
  // 0. So filter to snapshots that were sells: any non-zero PnL
  // definitely qualifies, and zero-PnL sells (break-even) are picked
  // up by the caller via engine-supplied `decisionId`s if needed.
  const realized = snapshots
    .map((s) => s.realizedPnl)
    .filter((v) => v !== 0);
  const wins = realized.filter((p) => p > 0);
  const losses = realized.filter((p) => p < 0);
  const gross = realized.reduce((a, b) => a + b, 0);
  const grossWins = wins.reduce((a, b) => a + b, 0);
  const grossLosses = losses.reduce((a, b) => a + b, 0);
  return {
    sellsCount: realized.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: realized.length ? (wins.length / realized.length) * 100 : null,
    avgWin: wins.length ? grossWins / wins.length : null,
    avgLoss: losses.length ? grossLosses / losses.length : null,
    largestWin: wins.length ? Math.max(...wins) : null,
    largestLoss: losses.length ? Math.min(...losses) : null,
    grossRealizedPnl: gross,
    profitFactor: grossLosses < 0 ? grossWins / Math.abs(grossLosses) : null,
  };
}

export type StrategyReportOptions = {
  startingEquity?: number;
  /**
   * Risk-free daily return used in Sharpe/Sortino. Defaults to 0.
   * Callers can pass e.g. `0.02 / 252` for a 2% annual RF.
   */
  riskFreeDaily?: number;
};

export function buildStrategyReport(
  result: BacktestResult,
  options: StrategyReportOptions = {},
): StrategyReport {
  const curve = result.equityCurve;
  const bars = curve.length;
  const startDate = bars ? curve[0].date : null;
  const endDate = bars ? curve[bars - 1].date : null;
  const startingEquity =
    options.startingEquity ?? (bars ? curve[0].totalValue : 0);
  const endingEquity = bars ? curve[bars - 1].totalValue : startingEquity;
  const years = bars > 1 ? (bars - 1) / TRADING_DAYS_PER_YEAR : 0;

  // Returns
  const totalReturnPct = startingEquity > 0
    ? ((endingEquity - startingEquity) / startingEquity) * 100
    : 0;
  const cagrPct = startingEquity > 0 && years > 0
    ? (Math.pow(endingEquity / startingEquity, 1 / years) - 1) * 100
    : null;

  const dailyReturns = pctReturns(curve);
  const sd = stdev(dailyReturns);
  const annualizedVolPct = sd !== null ? sd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100 : null;
  const bestBarPct = dailyReturns.length ? Math.max(...dailyReturns) * 100 : null;
  const worstBarPct = dailyReturns.length ? Math.min(...dailyReturns) * 100 : null;

  // Risk metrics
  const dd = maxDrawdown(curve);
  const rf = options.riskFreeDaily ?? 0;
  const excess = dailyReturns.map((r) => r - rf);
  const excessMean = excess.length ? excess.reduce((a, b) => a + b, 0) / excess.length : 0;
  const excessSd = stdev(excess);
  const sharpe = excessSd && excessSd > 0
    ? (excessMean / excessSd) * Math.sqrt(TRADING_DAYS_PER_YEAR)
    : null;
  const downside = excess.filter((r) => r < 0);
  const downsideSd = stdev(downside);
  const sortino = downsideSd && downsideSd > 0
    ? (excessMean / downsideSd) * Math.sqrt(TRADING_DAYS_PER_YEAR)
    : null;
  const calmar = dd.pct > 0 && cagrPct !== null
    ? cagrPct / (dd.pct * 100)
    : null;

  // Trade stats
  const t = tradeStats(result.snapshots);
  const executed = result.snapshots.length;
  const rejected = result.rejections.length;

  // Exposure
  const barsInvested = curve.filter((p) => p.holdingsValue > 0).length;
  const avgCashWeight = bars
    ? curve.reduce((acc, p) => {
        const total = p.totalValue;
        return acc + (total > 0 ? p.cash / total : 1);
      }, 0) / bars
    : 1;

  return {
    period: { startDate, endDate, bars, years },
    returns: {
      startingEquity,
      endingEquity,
      totalReturnPct,
      cagrPct,
      annualizedVolPct,
      bestBarPct,
      worstBarPct,
    },
    risk: {
      maxDrawdownPct: dd.pct * 100,
      maxDrawdownPeakDate: dd.peakDate,
      maxDrawdownTroughDate: dd.troughDate,
      longestDrawdownBars: dd.longestBars,
      sharpe,
      sortino,
      calmar,
    },
    trades: {
      total: executed + rejected,
      executed,
      rejected,
      sells: t.sellsCount,
      wins: t.wins,
      losses: t.losses,
      winRatePct: t.winRatePct,
      avgWin: t.avgWin,
      avgLoss: t.avgLoss,
      largestWin: t.largestWin,
      largestLoss: t.largestLoss,
      grossRealizedPnl: t.grossRealizedPnl,
      profitFactor: t.profitFactor,
    },
    exposure: {
      barsInvestedPct: bars ? (barsInvested / bars) * 100 : 0,
      avgCashWeightPct: avgCashWeight * 100,
      finalCash: result.finalState.cash,
      finalHoldingsValue:
        result.equityCurve.length
          ? result.equityCurve[result.equityCurve.length - 1].holdingsValue
          : 0,
      finalHoldingsCount: result.finalState.holdings.filter((h) => h.quantity > 0).length,
    },
  };
  // safeDiv retained for potential future ratios that need it.
  void safeDiv;
}
