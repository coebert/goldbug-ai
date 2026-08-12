// Quick RSI strategy backtest over whatever window the chart is showing.
//
// Deliberately simple and honest: long-only, one position at a time, enter on
// an RSI buy marker at that bar's close, exit on the next sell marker (or at
// the last bar, marked open). Round-trip friction is charged on every trade so
// the headline return is net, not the gross fantasy version.

import { detectRsiSignals, type RsiSignalMode } from "./rsi-signals";
import type { HistoryPoint } from "./market-symbol-history";

/** Default round-trip cost in basis points (commission + spread + stamp-ish). */
export const DEFAULT_RSI_BACKTEST_FRICTION_BPS = 40;

export interface RsiTrade {
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  /** Net return after friction, as a fraction (0.05 = +5%). */
  netReturn: number;
  bars: number;
  /** True when the position was still open at the end of the window. */
  open: boolean;
}

export interface RsiBacktestResult {
  mode: RsiSignalMode;
  frictionBps: number;
  trades: RsiTrade[];
  /** Compounded net return of the strategy across the window. */
  totalReturn: number;
  /** Buy-and-hold return over the same window, for context. */
  buyHoldReturn: number;
  winRate: number;
  avgReturn: number;
  /** Deepest peak-to-trough fall of the strategy equity curve. */
  maxDrawdown: number;
  /** Fraction of bars the strategy held a position. */
  exposure: number;
  bars: number;
}

function drawdown(curve: number[]): number {
  let peak = curve[0] ?? 1;
  let worst = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst;
}

export function backtestRsiStrategy(
  points: HistoryPoint[],
  mode: RsiSignalMode,
  opts: { frictionBps?: number } = {},
): RsiBacktestResult {
  const frictionBps = opts.frictionBps ?? DEFAULT_RSI_BACKTEST_FRICTION_BPS;
  const friction = frictionBps / 10_000;
  const usable = points.filter((p) => Number.isFinite(p.close));
  const signals = detectRsiSignals(points, mode);
  const byDate = new Map(signals.map((s) => [s.date, s] as const));

  const trades: RsiTrade[] = [];
  let entry: { date: string; price: number; index: number } | null = null;
  let equity = 1;
  const curve: number[] = [];
  let heldBars = 0;

  usable.forEach((p, i) => {
    const sig = byDate.get(p.date);
    if (entry) {
      // Mark-to-market while the position is open.
      curve.push(equity * (p.close / entry.price) * (1 - friction));
      heldBars += 1;
    } else {
      curve.push(equity);
    }

    if (!entry && sig?.kind === "buy") {
      entry = { date: p.date, price: p.close, index: i };
      return;
    }
    if (entry && sig?.kind === "sell") {
      const gross = p.close / entry.price;
      const net = gross * (1 - friction) - 1;
      trades.push({
        entryDate: entry.date,
        entryPrice: entry.price,
        exitDate: p.date,
        exitPrice: p.close,
        netReturn: net,
        bars: i - entry.index,
        open: false,
      });
      equity *= 1 + net;
      curve[curve.length - 1] = equity;
      entry = null;
    }
  });

  // Close any still-open position at the last bar so the numbers are complete.
  const last = usable[usable.length - 1];
  if (entry && last) {
    const open = entry as { date: string; price: number; index: number };
    const net = (last.close / open.price) * (1 - friction) - 1;
    trades.push({
      entryDate: open.date,
      entryPrice: open.price,
      exitDate: last.date,
      exitPrice: last.close,
      netReturn: net,
      bars: usable.length - 1 - open.index,
      open: true,
    });
    equity *= 1 + net;
    if (curve.length) curve[curve.length - 1] = equity;
  }

  const wins = trades.filter((t) => t.netReturn > 0).length;
  const first = usable[0];
  return {
    mode,
    frictionBps,
    trades,
    totalReturn: equity - 1,
    buyHoldReturn: first && last && first.close > 0 ? last.close / first.close - 1 : 0,
    winRate: trades.length ? wins / trades.length : 0,
    avgReturn: trades.length
      ? trades.reduce((a, t) => a + t.netReturn, 0) / trades.length
      : 0,
    maxDrawdown: drawdown(curve.length ? curve : [1]),
    exposure: usable.length ? heldBars / usable.length : 0,
    bars: usable.length,
  };
}
