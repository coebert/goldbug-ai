// Backtest vs real P&L comparison.
//
// A saved backtest run answers "what should the strategy have made?". The
// live book answers "what did it actually make?". The gap between the two is
// the part that matters: it is execution — spread, slippage, fees, partial
// fills, missed entries — not strategy. This module lines the two curves up
// on the days they share and quantifies that gap.
//
// Rules that keep the comparison honest:
//   • Real equity is flow-netted first, so deposits/withdrawals never read as
//     performance (see equity-external-flows).
//   • Both curves are rebased to 100 at the FIRST SHARED DAY, so a difference
//     in account size can't distort the shape.
//   • Only overlapping dates are compared. If the backtest ran over a window
//     the live book doesn't cover, the non-overlapping part is dropped rather
//     than extrapolated.
//   • Realised fees are reported separately in basis points of starting
//     equity, so you can see how much of the gap the broker took.
//
// Pure module: no I/O.

import { computeMaxDrawdown, dailyReturns, type EquityPoint as MetricPoint } from "@/lib/backtest-metrics";

export type CurvePoint = { date: string; value: number };

export type CurveStats = {
  /** Start-to-end change over the shared window, in percent. */
  totalReturnPct: number;
  /** Worst peak-to-trough drop over the shared window (negative percent). */
  maxDrawdownPct: number;
  /** Best single day in the shared window, percent. */
  bestDayPct: number;
  /** Worst single day in the shared window, percent. */
  worstDayPct: number;
  /** Share of days that closed up, percent. Null when there are no steps. */
  upDayPct: number | null;
};

export type ComparisonPoint = {
  date: string;
  /** Backtest curve rebased to 100 at the first shared day. */
  backtest: number;
  /** Real curve rebased to 100 at the first shared day. */
  real: number;
  /** real − backtest, in index points (≈ percentage points of the base). */
  gap: number;
};

export type BacktestVsReal = {
  /** Aligned, rebased curves for charting. Empty when there is no overlap. */
  points: ComparisonPoint[];
  backtestStats: CurveStats;
  realStats: CurveStats;
  /** realStats.totalReturnPct − backtestStats.totalReturnPct. */
  returnGapPct: number;
  /** realStats.maxDrawdownPct − backtestStats.maxDrawdownPct (negative = real was worse). */
  drawdownGapPct: number;
  /** Money terms: what the real book made over the window. */
  realPnl: number;
  /** Money terms: what the same starting capital would have made on the backtest curve. */
  backtestPnl: number;
  /** realPnl − backtestPnl. Negative means live execution cost you money. */
  pnlGap: number;
  /** Real equity at the first shared day (flow-netted), used as the money base. */
  startEquity: number;
  /** Total realised broker fees inside the shared window. */
  fees: number;
  /** Fees as basis points of startEquity. */
  feesBps: number;
  /** How much of the return gap the fees explain, as a share 0..1 (null if no gap). */
  feeShareOfGap: number | null;
  /** Number of shared days compared. */
  days: number;
  /** Inclusive shared window. */
  from: string | null;
  to: string | null;
  /** Days in either curve that had no partner and were dropped. */
  droppedBacktestDays: number;
  droppedRealDays: number;
};

const EMPTY_STATS: CurveStats = {
  totalReturnPct: 0,
  maxDrawdownPct: 0,
  bestDayPct: 0,
  worstDayPct: 0,
  upDayPct: null,
};

export const EMPTY_COMPARISON: BacktestVsReal = {
  points: [],
  backtestStats: EMPTY_STATS,
  realStats: EMPTY_STATS,
  returnGapPct: 0,
  drawdownGapPct: 0,
  realPnl: 0,
  backtestPnl: 0,
  pnlGap: 0,
  startEquity: 0,
  fees: 0,
  feesBps: 0,
  feeShareOfGap: null,
  days: 0,
  from: null,
  to: null,
  droppedBacktestDays: 0,
  droppedRealDays: 0,
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Collapses to one point per calendar day, keeping the last value of the day. */
function byDay(points: CurvePoint[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of [...points].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const v = Number(p.value);
    if (!Number.isFinite(v)) continue;
    out.set(dayKey(p.date), v);
  }
  return out;
}

export function curveStats(values: number[]): CurveStats {
  if (values.length < 2) return EMPTY_STATS;
  const first = values[0];
  const last = values[values.length - 1];
  const asMetric: MetricPoint[] = values.map((v, i) => ({
    snapshot_date: String(i),
    total_value: v,
  }));
  const rets = dailyReturns(asMetric);
  const dd = computeMaxDrawdown(asMetric);
  const ups = rets.filter((r) => r > 0).length;
  return {
    totalReturnPct: first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0,
    maxDrawdownPct: dd.pct,
    bestDayPct: rets.length ? Math.max(...rets) * 100 : 0,
    worstDayPct: rets.length ? Math.min(...rets) * 100 : 0,
    upDayPct: rets.length ? (ups / rets.length) * 100 : null,
  };
}

/**
 * Aligns a saved backtest equity curve against the real (flow-netted) equity
 * curve and quantifies the execution gap between them.
 *
 * @param fees realised broker fees; only rows inside the shared window should
 *             be passed in, keyed by date so the caller can filter loosely.
 */
export function compareBacktestToReal(input: {
  backtest: CurvePoint[];
  real: CurvePoint[];
  fees?: Array<{ date: string; amount: number }>;
}): BacktestVsReal {
  const bt = byDay(input.backtest ?? []);
  const rl = byDay(input.real ?? []);
  const shared = [...bt.keys()].filter((d) => rl.has(d)).sort();

  if (shared.length < 2) {
    return {
      ...EMPTY_COMPARISON,
      droppedBacktestDays: Math.max(0, bt.size - shared.length),
      droppedRealDays: Math.max(0, rl.size - shared.length),
    };
  }

  const from = shared[0];
  const to = shared[shared.length - 1];
  const btVals = shared.map((d) => bt.get(d) as number);
  const rlVals = shared.map((d) => rl.get(d) as number);
  const btBase = btVals[0];
  const rlBase = rlVals[0];

  const points: ComparisonPoint[] = shared.map((d, i) => {
    const b = btBase !== 0 ? (btVals[i] / btBase) * 100 : 100;
    const r = rlBase !== 0 ? (rlVals[i] / rlBase) * 100 : 100;
    return { date: d, backtest: b, real: r, gap: r - b };
  });

  const backtestStats = curveStats(btVals);
  const realStats = curveStats(rlVals);

  const startEquity = rlBase;
  const realPnl = rlVals[rlVals.length - 1] - rlBase;
  const backtestPnl = startEquity * (backtestStats.totalReturnPct / 100);

  const fees = (input.fees ?? [])
    .filter((f) => {
      const d = dayKey(f.date);
      return d >= from && d <= to;
    })
    .reduce((s, f) => s + (Number.isFinite(f.amount) ? Math.abs(Number(f.amount)) : 0), 0);

  const returnGapPct = realStats.totalReturnPct - backtestStats.totalReturnPct;
  const pnlGap = realPnl - backtestPnl;
  const feesBps = startEquity > 0 ? (fees / startEquity) * 10_000 : 0;
  // Fees only "explain" a shortfall — a gap in your favour isn't explained by
  // paying the broker, so the share is only defined when the real book lagged.
  const feeShareOfGap =
    pnlGap < 0 && fees > 0 ? Math.min(1, fees / Math.abs(pnlGap)) : pnlGap < 0 ? 0 : null;

  return {
    points,
    backtestStats,
    realStats,
    returnGapPct,
    drawdownGapPct: realStats.maxDrawdownPct - backtestStats.maxDrawdownPct,
    realPnl,
    backtestPnl,
    pnlGap,
    startEquity,
    fees,
    feesBps,
    feeShareOfGap,
    days: shared.length,
    from,
    to,
    droppedBacktestDays: Math.max(0, bt.size - shared.length),
    droppedRealDays: Math.max(0, rl.size - shared.length),
  };
}

/** One-line plain-English read of the comparison, for the card header. */
export function verdictFor(c: BacktestVsReal): string {
  if (c.days < 2) return "Not enough overlapping days to compare yet.";
  const gap = c.returnGapPct;
  if (Math.abs(gap) < 0.25) return "Live P&L is tracking the backtest closely.";
  if (gap < 0) {
    const feePart =
      c.feeShareOfGap != null && c.feeShareOfGap > 0.5
        ? " — mostly broker costs"
        : c.feesBps > 0
          ? ` — ${c.feesBps.toFixed(0)}bps of it is broker costs`
          : "";
    return `Live is ${Math.abs(gap).toFixed(2)} points behind the backtest${feePart}.`;
  }
  return `Live is ${gap.toFixed(2)} points ahead of the backtest.`;
}
