// Strategy performance metrics for the live account.
//
// Answers "how has the strategy actually done?" in the terms an investor
// judges a strategy by: annualised return, risk-adjusted return, and how bad
// the losing stretches were — not just the ending equity number.
//
// Rules that keep it honest:
//   • The caller passes a FLOW-ADJUSTED curve (see equity-external-flows), so
//     deposits and withdrawals never read as performance.
//   • Annualised return is only reported once the window is long enough to
//     annualise (>= 30 days). Below that, annualising a handful of days
//     produces a fantasy number, so it is withheld.
//   • Drawdowns are reported as episodes (peak → trough → recovery), so a
//     single deep-but-brief dip is distinguishable from a long grind.
//
// Pure module: no I/O.

import {
  computeAnnualisedVolPct,
  computeSharpe,
  dailyReturns,
  type EquityPoint as MetricPoint,
} from "@/lib/backtest-metrics";

export type PerfPoint = { date: string; value: number };

export type DrawdownEpisode = {
  peakDate: string;
  troughDate: string;
  /** Null while the account has not yet made a new high. */
  recoveryDate: string | null;
  /** Depth as a NEGATIVE percent. */
  depthPct: number;
  /** Calendar days from peak to trough. */
  daysToTrough: number;
  /** Calendar days from trough back to the old high. Null when unrecovered. */
  daysToRecover: number | null;
};

export type StrategyPerformance = {
  from: string | null;
  to: string | null;
  /** Points in the curve. */
  days: number;
  /** Calendar years spanned. */
  years: number;
  startEquity: number;
  endEquity: number;
  /** Money made over the window, net of external flows. */
  pnl: number;
  totalReturnPct: number;
  /** CAGR. Null when the window is too short to annualise honestly. */
  annualisedReturnPct: number | null;
  /** Annualised Sharpe, rf = 0. */
  sharpe: number;
  /** Annualised Sortino (downside deviation only). Null with no down days. */
  sortino: number | null;
  volAnnPct: number;
  maxDrawdownPct: number;
  maxDrawdownPeakDate: string | null;
  maxDrawdownTroughDate: string | null;
  /** How far below the running high the account sits right now (<= 0). */
  currentDrawdownPct: number;
  bestDayPct: number;
  worstDayPct: number;
  upDayPct: number | null;
  /** Deepest episodes first. */
  drawdowns: DrawdownEpisode[];
};

/** Minimum window before a return is annualised. */
export const MIN_DAYS_TO_ANNUALISE = 30;

const MS_DAY = 24 * 3600 * 1000;
const TRADING_DAYS = 252;

export const EMPTY_PERFORMANCE: StrategyPerformance = {
  from: null,
  to: null,
  days: 0,
  years: 0,
  startEquity: 0,
  endEquity: 0,
  pnl: 0,
  totalReturnPct: 0,
  annualisedReturnPct: null,
  sharpe: 0,
  sortino: null,
  volAnnPct: 0,
  maxDrawdownPct: 0,
  maxDrawdownPeakDate: null,
  maxDrawdownTroughDate: null,
  currentDrawdownPct: 0,
  bestDayPct: 0,
  worstDayPct: 0,
  upDayPct: null,
  drawdowns: [],
};

function dayDiff(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return Math.max(0, Math.round((y - x) / MS_DAY));
}

/**
 * Every peak → trough → recovery episode in the curve, deepest first.
 * The final episode is left open (recoveryDate null) when the account has
 * not regained its high by the last point.
 */
export function drawdownEpisodes(points: PerfPoint[], minDepthPct = 0.5): DrawdownEpisode[] {
  const out: DrawdownEpisode[] = [];
  if (points.length < 2) return out;
  let peak = points[0]!.value;
  let peakDate = points[0]!.date;
  let trough = peak;
  let troughDate = peakDate;
  let inDrawdown = false;

  const close = (recoveryDate: string | null) => {
    if (!inDrawdown || !(peak > 0)) return;
    const depthPct = ((trough - peak) / peak) * 100;
    if (depthPct <= -minDepthPct) {
      out.push({
        peakDate,
        troughDate,
        recoveryDate,
        depthPct,
        daysToTrough: dayDiff(peakDate, troughDate),
        daysToRecover: recoveryDate ? dayDiff(troughDate, recoveryDate) : null,
      });
    }
    inDrawdown = false;
  };

  for (const p of points) {
    const v = p.value;
    if (!Number.isFinite(v)) continue;
    if (v >= peak) {
      close(p.date);
      peak = v;
      peakDate = p.date;
      trough = v;
      troughDate = p.date;
      continue;
    }
    if (!inDrawdown) {
      inDrawdown = true;
      trough = v;
      troughDate = p.date;
    } else if (v < trough) {
      trough = v;
      troughDate = p.date;
    }
  }
  close(null);
  return out.sort((a, b) => a.depthPct - b.depthPct);
}

/** Annualised Sortino: excess return over downside deviation. */
export function computeSortino(returns: number[]): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const down = returns.filter((r) => r < 0);
  if (down.length === 0) return null;
  const dd = Math.sqrt(down.reduce((a, r) => a + r * r, 0) / down.length);
  if (!(dd > 0)) return null;
  return (mean / dd) * Math.sqrt(TRADING_DAYS);
}

/**
 * Headline performance of an equity curve. `points` must already be
 * flow-adjusted and sorted ascending by date.
 */
export function computeStrategyPerformance(points: PerfPoint[]): StrategyPerformance {
  const clean = points
    .filter((p) => p?.date && Number.isFinite(Number(p.value)))
    .map((p) => ({ date: String(p.date).slice(0, 10), value: Number(p.value) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (clean.length < 2) return EMPTY_PERFORMANCE;

  const first = clean[0]!;
  const last = clean[clean.length - 1]!;
  const startEquity = first.value;
  const endEquity = last.value;
  const spanDays = dayDiff(first.date, last.date);
  const years = spanDays / 365.25;

  const totalReturnPct = startEquity > 0 ? ((endEquity - startEquity) / startEquity) * 100 : 0;
  const growth = startEquity > 0 ? endEquity / startEquity : 0;
  const annualisedReturnPct =
    spanDays >= MIN_DAYS_TO_ANNUALISE && years > 0 && growth > 0
      ? (Math.pow(growth, 1 / years) - 1) * 100
      : null;

  const metricPoints: MetricPoint[] = clean.map((p) => ({
    snapshot_date: p.date,
    total_value: p.value,
  }));
  const rets = dailyReturns(metricPoints);
  const up = rets.filter((r) => r > 0).length;
  const down = rets.filter((r) => r < 0).length;

  const episodes = drawdownEpisodes(clean);
  const worstEpisode = episodes[0] ?? null;

  // Where the account sits versus its own running high, right now.
  let runningPeak = clean[0]!.value;
  for (const p of clean) if (p.value > runningPeak) runningPeak = p.value;
  const currentDrawdownPct = runningPeak > 0 ? ((endEquity - runningPeak) / runningPeak) * 100 : 0;

  return {
    from: first.date,
    to: last.date,
    days: clean.length,
    years,
    startEquity,
    endEquity,
    pnl: endEquity - startEquity,
    totalReturnPct,
    annualisedReturnPct,
    sharpe: computeSharpe(rets),
    sortino: computeSortino(rets),
    volAnnPct: computeAnnualisedVolPct(rets),
    maxDrawdownPct: worstEpisode?.depthPct ?? 0,
    maxDrawdownPeakDate: worstEpisode?.peakDate ?? null,
    maxDrawdownTroughDate: worstEpisode?.troughDate ?? null,
    currentDrawdownPct: Math.min(0, currentDrawdownPct),
    bestDayPct: rets.length ? Math.max(...rets) * 100 : 0,
    worstDayPct: rets.length ? Math.min(...rets) * 100 : 0,
    upDayPct: up + down > 0 ? (up / (up + down)) * 100 : null,
    drawdowns: episodes,
  };
}
