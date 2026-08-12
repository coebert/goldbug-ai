// Backtest of the RSI divergence signals drawn on the chart.
//
// Honest by construction:
//   - A divergence is only tradable once its second pivot is CONFIRMED, which
//     needs `lookaround` bars of future tape. Entry is therefore taken at the
//     close of `to.index + lookaround`, never at the pivot itself — otherwise
//     the test would be buying at a low it could not have known about.
//   - Bullish divergences are taken long, bearish short (the mirror trade), so
//     both sides are measured on the same footing.
//   - Each setup runs until it hits the target, breaks its invalidation level
//     (a close beyond the signal pivot's extreme), or the horizon expires.
//   - Round-trip friction is charged on every setup so returns are net.

import { detectRsiDivergences, type DivergenceOptions, type RsiDivergence } from "./rsi-divergence";
import type { HistoryPoint } from "./market-symbol-history";

export const DEFAULT_DIVERGENCE_HORIZON = 15;
export const DEFAULT_DIVERGENCE_TARGET_PCT = 3;
export const DEFAULT_DIVERGENCE_FRICTION_BPS = 40;

export type DivergenceOutcome = "reversal" | "failed" | "timeout";

export interface DivergenceTrade {
  kind: RsiDivergence["kind"];
  /** Date of the second (signal) pivot. */
  pivotDate: string;
  /** Bar actually traded, once the pivot was confirmed. */
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  bars: number;
  outcome: DivergenceOutcome;
  /** Net directional return after friction (positive = the divergence paid). */
  netReturn: number;
  /** Best favourable excursion while open, as a fraction. */
  mfe: number;
  /** Worst adverse excursion while open, as a fraction (positive number). */
  mae: number;
  /** Price level that invalidated (or would invalidate) the setup. */
  invalidation: number;
}

export interface DivergenceStats {
  trades: number;
  /** Share of setups that reached the profit target first. */
  hitRate: number;
  /** Share of setups stopped out at the invalidation level. */
  failRate: number;
  avgReturn: number;
  medianReturn: number;
  /** Sum of wins / sum of losses; Infinity when there are no losses. */
  profitFactor: number;
  expectancy: number;
  avgBars: number;
  avgMfe: number;
  avgMae: number;
}

export interface DivergenceBacktestResult {
  horizon: number;
  targetPct: number;
  frictionBps: number;
  bars: number;
  trades: DivergenceTrade[];
  overall: DivergenceStats;
  bullish: DivergenceStats;
  bearish: DivergenceStats;
}

export interface DivergenceBacktestOptions {
  /** Max bars a setup is held before it is closed at market. */
  horizon?: number;
  /** Favourable move (in %) that counts as a successful reversal. */
  targetPct?: number;
  /** Round-trip cost charged on every setup, in basis points. */
  frictionBps?: number;
  /** Passed straight through to the detector so chart and test agree. */
  detector?: DivergenceOptions;
  /** Bars of confirmation the detector needs; must match `detector.lookaround`. */
  lookaround?: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function summarise(trades: DivergenceTrade[]): DivergenceStats {
  if (!trades.length) {
    return {
      trades: 0,
      hitRate: 0,
      failRate: 0,
      avgReturn: 0,
      medianReturn: 0,
      profitFactor: 0,
      expectancy: 0,
      avgBars: 0,
      avgMfe: 0,
      avgMae: 0,
    };
  }
  const rets = trades.map((t) => t.netReturn);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
  return {
    trades: trades.length,
    hitRate: trades.filter((t) => t.outcome === "reversal").length / trades.length,
    failRate: trades.filter((t) => t.outcome === "failed").length / trades.length,
    avgReturn: avg,
    medianReturn: median(rets),
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss,
    expectancy: avg,
    avgBars: trades.reduce((a, t) => a + t.bars, 0) / trades.length,
    avgMfe: trades.reduce((a, t) => a + t.mfe, 0) / trades.length,
    avgMae: trades.reduce((a, t) => a + t.mae, 0) / trades.length,
  };
}

/**
 * Replay every divergence in `points` and report how often it led to a real
 * reversal versus a failed setup.
 */
export function backtestRsiDivergences(
  points: HistoryPoint[],
  options: DivergenceBacktestOptions = {},
): DivergenceBacktestResult {
  const horizon = Math.max(1, options.horizon ?? DEFAULT_DIVERGENCE_HORIZON);
  const targetPct = Math.max(0.1, options.targetPct ?? DEFAULT_DIVERGENCE_TARGET_PCT);
  const frictionBps = Math.max(0, options.frictionBps ?? DEFAULT_DIVERGENCE_FRICTION_BPS);
  const lookaround = options.lookaround ?? options.detector?.lookaround ?? 3;
  const friction = frictionBps / 10_000;
  const target = targetPct / 100;

  const divergences = detectRsiDivergences(points, {
    ...options.detector,
    lookaround,
  });

  const trades: DivergenceTrade[] = [];

  for (const d of divergences) {
    const entryIndex = d.to.index + lookaround;
    if (entryIndex >= points.length - 1) continue; // no tradable tape after confirmation
    const entry = points[entryIndex];
    if (!(entry.close > 0)) continue;

    const long = d.kind === "bullish";
    const invalidation = d.to.price; // the pivot that produced the divergence
    const lastIndex = Math.min(points.length - 1, entryIndex + horizon);

    let exitIndex = lastIndex;
    let outcome: DivergenceOutcome = "timeout";
    let mfe = 0;
    let mae = 0;

    for (let i = entryIndex + 1; i <= lastIndex; i++) {
      const c = points[i].close;
      const move = long ? c / entry.close - 1 : 1 - c / entry.close;
      mfe = Math.max(mfe, move);
      mae = Math.max(mae, -move);

      const broken = long ? c < invalidation : c > invalidation;
      if (move >= target) {
        exitIndex = i;
        outcome = "reversal";
        break;
      }
      if (broken) {
        exitIndex = i;
        outcome = "failed";
        break;
      }
    }

    const exit = points[exitIndex];
    const gross = long ? exit.close / entry.close - 1 : 1 - exit.close / entry.close;

    trades.push({
      kind: d.kind,
      pivotDate: d.to.date,
      entryDate: entry.date,
      entryPrice: entry.close,
      exitDate: exit.date,
      exitPrice: exit.close,
      bars: exitIndex - entryIndex,
      outcome,
      netReturn: gross - friction,
      mfe,
      mae,
      invalidation,
    });
  }

  return {
    horizon,
    targetPct,
    frictionBps,
    bars: points.length,
    trades,
    overall: summarise(trades),
    bullish: summarise(trades.filter((t) => t.kind === "bullish")),
    bearish: summarise(trades.filter((t) => t.kind === "bearish")),
  };
}

/** One-line plain-language verdict for the panel header. */
export function divergenceBacktestVerdict(r: DivergenceBacktestResult): string {
  const n = r.overall.trades;
  if (!n) return "No confirmed divergences with enough forward tape in this window.";
  const hit = Math.round(r.overall.hitRate * 100);
  const fail = Math.round(r.overall.failRate * 100);
  const avg = (r.overall.avgReturn * 100).toFixed(2);
  const tone =
    r.overall.avgReturn > 0 && r.overall.hitRate >= r.overall.failRate
      ? "the setups paid on average"
      : "the setups lost money on average";
  return `${n} confirmed divergence${n === 1 ? "" : "s"}: ${hit}% reached the ${r.targetPct}% target, ${fail}% broke their invalidation level, ${avg}% net per setup — ${tone}.`;
}
