// Per-symbol and per-signal diagnostics for the breakout signal backtest.
//
// The headline report answers "did confirmed breakouts beat failed ones?".
// This module answers the follow-up: *where* did that gap come from. Two
// cuts, both pure functions over the trades the backtest already produced:
//
//   symbolDiagnostics()      — one row per symbol, confirmed vs failed, plus
//                              each symbol's share of the cohort's total P&L
//                              so a single name carrying (or sinking) the
//                              result is impossible to miss.
//   signalStateDiagnostics() — one block per breakout state, split by trade
//                              direction, exit reason and evidence-quality
//                              bucket, so a state that only works on, say,
//                              downside breaks that hit their target shows up.
//
// No I/O, no clock, no randomness — same trades in, same rows out.

import type { SignalCohort, SignalTrade } from "@/lib/breakout-backtest";
import type { RegimeLabel } from "@/lib/regime-walk-forward";
import {
  DEFAULT_BREAKOUT_REGIME_POLICY,
  type BreakoutRegimePolicyConfig,
} from "@/lib/alpha/breakout-regime-policy";

export type SignalSlice = {
  trades: number;
  wins: number;
  winRatePct: number;
  avgReturnPct: number;
  medianReturnPct: number;
  /** Sum of net returns at 1 unit per signal — the P&L contribution. */
  sumReturnPct: number;
  bestPct: number;
  worstPct: number;
  avgBarsHeld: number;
};

export const EMPTY_SLICE: SignalSlice = {
  trades: 0,
  wins: 0,
  winRatePct: 0,
  avgReturnPct: 0,
  medianReturnPct: 0,
  sumReturnPct: 0,
  bestPct: 0,
  worstPct: 0,
  avgBarsHeld: 0,
};

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function summarizeSlice(trades: readonly SignalTrade[]): SignalSlice {
  if (!trades.length) return { ...EMPTY_SLICE };
  const rets = trades.map((t) => t.returnPct);
  const sum = rets.reduce((a, b) => a + b, 0);
  const wins = rets.filter((r) => r > 0).length;
  return {
    trades: trades.length,
    wins,
    winRatePct: (wins / trades.length) * 100,
    avgReturnPct: sum / trades.length,
    medianReturnPct: median(rets),
    sumReturnPct: sum,
    bestPct: Math.max(...rets),
    worstPct: Math.min(...rets),
    avgBarsHeld: trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length,
  };
}

export type SymbolDiagnostic = {
  symbol: string;
  all: SignalSlice;
  confirmed: SignalSlice;
  failed: SignalSlice;
  /** confirmed − failed win rate, in percentage points. */
  winRateGapPp: number;
  /** confirmed − failed average return, in percentage points. */
  avgReturnGapPct: number;
  /**
   * Share of the confirmed cohort's *total absolute* P&L this symbol accounts
   * for, signed by its own contribution. +40 = this name produced 40% of the
   * cohort's gross movement and it was profitable.
   */
  confirmedContributionPct: number;
  /** Plain-language role of this symbol in the confirmed result. */
  role: "driver" | "drag" | "neutral" | "thin";
};

export type SymbolDiagnosticsOptions = {
  /** Minimum confirmed+failed signals before a symbol is judged. */
  minTrades?: number;
  /** Keep at most this many rows (highest absolute contribution first). */
  limit?: number;
};

export function symbolDiagnostics(
  trades: readonly SignalTrade[],
  options: SymbolDiagnosticsOptions = {},
): SymbolDiagnostic[] {
  const minTrades = options.minTrades ?? 3;
  const bySymbol = new Map<string, SignalTrade[]>();
  for (const t of trades) {
    const arr = bySymbol.get(t.symbol);
    if (arr) arr.push(t);
    else bySymbol.set(t.symbol, [t]);
  }

  const confirmedGross = trades
    .filter((t) => t.cohort === "confirmed")
    .reduce((a, t) => a + Math.abs(t.returnPct), 0);

  const rows: SymbolDiagnostic[] = [];
  for (const [symbol, ts] of bySymbol) {
    const confirmed = summarizeSlice(ts.filter((t) => t.cohort === "confirmed"));
    const failed = summarizeSlice(ts.filter((t) => t.cohort === "failed"));
    const contribution =
      confirmedGross > 0 ? (confirmed.sumReturnPct / confirmedGross) * 100 : 0;
    const judged = confirmed.trades + failed.trades >= minTrades && confirmed.trades > 0;
    const role: SymbolDiagnostic["role"] = !judged
      ? "thin"
      : contribution >= 5
        ? "driver"
        : contribution <= -5
          ? "drag"
          : "neutral";
    rows.push({
      symbol,
      all: summarizeSlice(ts),
      confirmed,
      failed,
      winRateGapPp: confirmed.winRatePct - failed.winRatePct,
      avgReturnGapPct: confirmed.avgReturnPct - failed.avgReturnPct,
      confirmedContributionPct: contribution,
      role,
    });
  }

  rows.sort(
    (a, b) =>
      Math.abs(b.confirmedContributionPct) - Math.abs(a.confirmedContributionPct) ||
      b.all.trades - a.all.trades ||
      (a.symbol < b.symbol ? -1 : 1),
  );
  return options.limit ? rows.slice(0, options.limit) : rows;
}

export type QualityBucket = "low" | "medium" | "high";
export const QUALITY_BUCKETS: readonly QualityBucket[] = ["low", "medium", "high"] as const;

export function qualityBucket(quality: number): QualityBucket {
  if (quality < 0.4) return "low";
  if (quality < 0.7) return "medium";
  return "high";
}

export type SignalStateDiagnostic = {
  cohort: SignalCohort;
  overall: SignalSlice;
  byDirection: { direction: "up" | "down"; slice: SignalSlice }[];
  byExitReason: { reason: SignalTrade["exitReason"]; slice: SignalSlice }[];
  byQuality: { bucket: QualityBucket; slice: SignalSlice }[];
  /** Average worst adverse excursion while open, in % (<= 0). */
  avgMaxAdversePct: number;
  /** Share of trades stopped out before the horizon. */
  stopRatePct: number;
  /** Share of trades that reached their profit target. */
  targetRatePct: number;
};

export function signalStateDiagnostics(
  trades: readonly SignalTrade[],
): SignalStateDiagnostic[] {
  const byCohort = new Map<SignalCohort, SignalTrade[]>();
  for (const t of trades) {
    const arr = byCohort.get(t.cohort);
    if (arr) arr.push(t);
    else byCohort.set(t.cohort, [t]);
  }

  const out: SignalStateDiagnostic[] = [];
  for (const [cohort, ts] of byCohort) {
    const reasons = Array.from(new Set(ts.map((t) => t.exitReason)));
    out.push({
      cohort,
      overall: summarizeSlice(ts),
      byDirection: (["up", "down"] as const)
        .map((direction) => ({
          direction,
          slice: summarizeSlice(ts.filter((t) => t.direction === direction)),
        }))
        .filter((d) => d.slice.trades > 0),
      byExitReason: reasons
        .map((reason) => ({
          reason,
          slice: summarizeSlice(ts.filter((t) => t.exitReason === reason)),
        }))
        .sort((a, b) => b.slice.trades - a.slice.trades),
      byQuality: QUALITY_BUCKETS.map((bucket) => ({
        bucket,
        slice: summarizeSlice(ts.filter((t) => qualityBucket(t.quality) === bucket)),
      })).filter((q) => q.slice.trades > 0),
      avgMaxAdversePct: ts.reduce((a, t) => a + t.maxAdversePct, 0) / ts.length,
      stopRatePct: (ts.filter((t) => t.exitReason === "stop").length / ts.length) * 100,
      targetRatePct: (ts.filter((t) => t.exitReason === "target").length / ts.length) * 100,
    });
  }

  const order: SignalCohort[] = ["confirmed", "pending", "extended", "failed"];
  out.sort((a, b) => order.indexOf(a.cohort) - order.indexOf(b.cohort));
  return out;
}

export type BreakoutDiagnostics = {
  symbols: SymbolDiagnostic[];
  states: SignalStateDiagnostic[];
  /** One-line takeaways for the UI, already ranked by usefulness. */
  notes: string[];
};

export function buildBreakoutDiagnostics(
  trades: readonly SignalTrade[],
  options: SymbolDiagnosticsOptions = {},
): BreakoutDiagnostics {
  const symbols = symbolDiagnostics(trades, options);
  const states = signalStateDiagnostics(trades);
  const notes: string[] = [];

  const drivers = symbols.filter((s) => s.role === "driver");
  const drags = symbols.filter((s) => s.role === "drag");
  if (drivers.length) {
    notes.push(
      `${drivers
        .slice(0, 3)
        .map((s) => `${s.symbol} (${s.confirmedContributionPct >= 0 ? "+" : ""}${s.confirmedContributionPct.toFixed(0)}%)`)
        .join(", ")} carry the confirmed cohort's P&L.`,
    );
  }
  if (drags.length) {
    notes.push(
      `${drags
        .slice(0, 3)
        .map((s) => `${s.symbol} (${s.confirmedContributionPct.toFixed(0)}%)`)
        .join(", ")} drag it down the hardest.`,
    );
  }
  const confirmed = states.find((s) => s.cohort === "confirmed");
  if (confirmed) {
    notes.push(
      `Confirmed signals stop out ${confirmed.stopRatePct.toFixed(0)}% of the time and reach target ${confirmed.targetRatePct.toFixed(0)}%.`,
    );
    const bestQ = [...confirmed.byQuality]
      .filter((q) => q.slice.trades >= 5)
      .sort((a, b) => b.slice.avgReturnPct - a.slice.avgReturnPct)[0];
    if (bestQ) {
      notes.push(
        `${bestQ.bucket} evidence-quality confirmations return ${bestQ.slice.avgReturnPct.toFixed(2)}% on average over ${bestQ.slice.trades} signals.`,
      );
    }
    const bestDir = [...confirmed.byDirection]
      .filter((d) => d.slice.trades >= 5)
      .sort((a, b) => b.slice.avgReturnPct - a.slice.avgReturnPct)[0];
    if (bestDir) {
      notes.push(
        `${bestDir.direction === "up" ? "Upside" : "Downside"} confirmations are the better side (${bestDir.slice.avgReturnPct.toFixed(2)}% avg over ${bestDir.slice.trades}).`,
      );
    }
  }

  return { symbols, states, notes };
}
