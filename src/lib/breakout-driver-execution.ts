import type { SignalTrade } from "@/lib/breakout-backtest";
import { symbolDiagnostics, topDrivers } from "@/lib/breakout-diagnostics";
import {
  RISK_LEVELS,
  recommendDriverAction,
  type DriverAction,
  type DriverRecommendation,
  type RiskLevel,
} from "@/lib/breakout-driver-actions";

/**
 * Feeds the driver recommendations back into the backtest.
 *
 * The Top-drivers panel ranks symbols (expectancy-gap weight) and maps each
 * row to an action and a size multiplier (risk setting). This module replays
 * the confirmed cohort with those multipliers applied as position sizes, so
 * every control has a measured P&L consequence instead of being advisory.
 *
 * Sizing rule: a confirmed trade on a ranked symbol is scaled by that
 * symbol's recommended multiplier (0 = the signal is skipped). Symbols with
 * too few confirmed signals to rank keep the baseline size.
 */
export type DriverSizingOptions = {
  risk: RiskLevel;
  gapWeight: number;
  /** Minimum confirmed signals before a symbol can be ranked. Default 3. */
  minConfirmed?: number;
  /** Size used for symbols that never got ranked. Default 1. */
  unrankedSize?: number;
};

export type SizedSymbolPlan = DriverRecommendation & {
  confirmedTrades: number;
  score: number;
};

export type ExecutionSummary = {
  risk: RiskLevel;
  gapWeight: number;
  /** Confirmed signals in the sample. */
  signals: number;
  /** Signals actually taken (size > 0). */
  taken: number;
  skipped: number;
  /** Mean size multiplier across all confirmed signals, skips included. */
  avgSize: number;
  /** Sum of sizes ÷ signals × 100 — capital deployed vs a flat-1 baseline. */
  deployedPct: number;
  winRatePct: number;
  /** Mean size-weighted return per confirmed signal, in %. */
  avgReturnPct: number;
  expectancyPct: number;
  /** Compounded return of the sized, chronologically ordered signals. */
  cumulativeReturnPct: number;
  maxDrawdownPct: number;
  /** Return per unit of size deployed — capital efficiency. */
  returnPerUnitPct: number;
  actionCounts: Record<DriverAction, number>;
};

export type ExecutionCell = ExecutionSummary & {
  /** Deltas versus the flat-1 baseline on the same trades. */
  vsBaseline: {
    cumulativeReturnPp: number;
    avgReturnPp: number;
    maxDrawdownPp: number;
    deployedPp: number;
  };
};

export type ExecutionGrid = {
  baseline: ExecutionSummary;
  risks: RiskLevel[];
  gapWeights: number[];
  cells: ExecutionCell[];
  /** Best cell by compounded return, if any signal was taken. */
  best: ExecutionCell | null;
  summary: string;
};

/** Gap weights offered by the UI slider and swept server-side. */
export const DEFAULT_GAP_WEIGHTS: readonly number[] = [0, 1, 2, 3, 4, 6];

const EMPTY_ACTIONS = (): Record<DriverAction, number> => ({
  prioritise: 0,
  trade: 0,
  downsize: 0,
  avoid: 0,
});

/** Recommendation per symbol for the whole ranked set (not just the top 5). */
export function driverSizingPlan(
  trades: readonly SignalTrade[],
  options: DriverSizingOptions,
): Map<string, SizedSymbolPlan> {
  const minConfirmed = options.minConfirmed ?? 3;
  const symbols = symbolDiagnostics(trades, { minTrades: 1, limit: 10_000 });
  const ranked = topDrivers(symbols, {
    limit: 10_000,
    minConfirmed,
    gapWeight: options.gapWeight,
  });
  const plan = new Map<string, SizedSymbolPlan>();
  for (const d of [...ranked.positive, ...ranked.negative]) {
    plan.set(d.symbol, {
      ...recommendDriverAction(d, options.risk),
      confirmedTrades: d.confirmedTrades,
      score: d.score,
    });
  }
  return plan;
}

function summarise(
  sized: readonly { returnPct: number; size: number }[],
  actionCounts: Record<DriverAction, number>,
  risk: RiskLevel,
  gapWeight: number,
): ExecutionSummary {
  const signals = sized.length;
  const totalSize = sized.reduce((a, t) => a + t.size, 0);
  const taken = sized.filter((t) => t.size > 0);
  const contributions = sized.map((t) => t.returnPct * t.size);
  const wins = taken.filter((t) => t.returnPct > 0).length;

  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const t of sized) {
    equity *= 1 + (t.returnPct * t.size) / 100;
    if (equity > peak) peak = equity;
    const dd = (equity / peak - 1) * 100;
    if (dd < maxDd) maxDd = dd;
  }

  const grossWin = contributions.filter((c) => c > 0).reduce((a, c) => a + c, 0);
  const grossLoss = contributions.filter((c) => c < 0).reduce((a, c) => a + c, 0);
  const avgReturnPct = signals ? contributions.reduce((a, c) => a + c, 0) / signals : 0;

  return {
    risk,
    gapWeight,
    signals,
    taken: taken.length,
    skipped: signals - taken.length,
    avgSize: signals ? totalSize / signals : 0,
    deployedPct: signals ? (totalSize / signals) * 100 : 0,
    winRatePct: taken.length ? (wins / taken.length) * 100 : 0,
    avgReturnPct,
    expectancyPct: taken.length ? (grossWin + grossLoss) / taken.length : 0,
    cumulativeReturnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDd,
    returnPerUnitPct: totalSize ? ((equity - 1) * 100) / (totalSize / Math.max(1, signals)) : 0,
    actionCounts,
  };
}

const chronological = (trades: readonly SignalTrade[]) =>
  [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

/** Replay the confirmed cohort at flat size 1 — the control for every cell. */
export function baselineExecution(trades: readonly SignalTrade[]): ExecutionSummary {
  const confirmed = chronological(trades.filter((t) => t.cohort === "confirmed"));
  return summarise(
    confirmed.map((t) => ({ returnPct: t.returnPct, size: 1 })),
    EMPTY_ACTIONS(),
    "balanced",
    0,
  );
}

/** Replay the confirmed cohort with driver-recommended sizes applied. */
export function applyDriverSizing(
  trades: readonly SignalTrade[],
  options: DriverSizingOptions,
): ExecutionSummary {
  const unrankedSize = options.unrankedSize ?? 1;
  const plan = driverSizingPlan(trades, options);
  const confirmed = chronological(trades.filter((t) => t.cohort === "confirmed"));
  const actionCounts = EMPTY_ACTIONS();
  const sized = confirmed.map((t) => {
    const rec = plan.get(t.symbol);
    if (rec) actionCounts[rec.action]++;
    return { returnPct: t.returnPct, size: rec ? rec.sizeMultiplier : unrankedSize };
  });
  return summarise(sized, actionCounts, options.risk, options.gapWeight);
}

export function buildExecutionGrid(
  trades: readonly SignalTrade[],
  options: {
    risks?: readonly RiskLevel[];
    gapWeights?: readonly number[];
    minConfirmed?: number;
    unrankedSize?: number;
  } = {},
): ExecutionGrid {
  const risks = [...(options.risks ?? RISK_LEVELS)];
  const gapWeights = [...(options.gapWeights ?? DEFAULT_GAP_WEIGHTS)];
  const baseline = baselineExecution(trades);

  const cells: ExecutionCell[] = [];
  for (const risk of risks) {
    for (const gapWeight of gapWeights) {
      const s = applyDriverSizing(trades, {
        risk,
        gapWeight,
        minConfirmed: options.minConfirmed,
        unrankedSize: options.unrankedSize,
      });
      cells.push({
        ...s,
        vsBaseline: {
          cumulativeReturnPp: s.cumulativeReturnPct - baseline.cumulativeReturnPct,
          avgReturnPp: s.avgReturnPct - baseline.avgReturnPct,
          maxDrawdownPp: s.maxDrawdownPct - baseline.maxDrawdownPct,
          deployedPp: s.deployedPct - baseline.deployedPct,
        },
      });
    }
  }

  const best =
    cells.filter((c) => c.taken > 0).sort((a, b) => b.cumulativeReturnPct - a.cumulativeReturnPct)[0] ??
    null;

  const summary = !baseline.signals
    ? "No confirmed signals to size."
    : best
      ? `Baseline (flat 1×) compounds ${baseline.cumulativeReturnPct.toFixed(1)}% at ${baseline.maxDrawdownPct.toFixed(1)}% drawdown. Best setting: ${best.risk} @ ${best.gapWeight}× gap → ${best.cumulativeReturnPct.toFixed(1)}% (${best.vsBaseline.cumulativeReturnPp >= 0 ? "+" : ""}${best.vsBaseline.cumulativeReturnPp.toFixed(1)}pp) using ${best.deployedPct.toFixed(0)}% of baseline capital.`
      : "Every setting sized the confirmed cohort to zero.";

  return { baseline, risks, gapWeights, cells, best, summary };
}

export function findExecutionCell(
  grid: ExecutionGrid,
  risk: RiskLevel,
  gapWeight: number,
): ExecutionCell | null {
  return grid.cells.find((c) => c.risk === risk && c.gapWeight === gapWeight) ?? null;
}
