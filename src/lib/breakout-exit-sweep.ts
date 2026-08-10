// Exit-parameter sweep for the breakout engine.
//
// The parameter sweep in `breakout-param-sweep.ts` tunes the DETECTOR (what
// counts as a breakout). This one holds the detector fixed and sweeps the
// TRADE MANAGEMENT: stop distance, profit target and holding horizon.
//
// Two things matter here and they pull in opposite directions:
//   * A tight stop lifts nothing on its own — it converts small losses into
//     more frequent ones, so win rate falls even as drawdown improves.
//   * A near target lifts win rate but caps the right tail, so average return
//     can collapse even while the hit rate looks great.
// So the report ranks on a blended objective (win rate + drawdown relief +
// expectancy) and ALSO surfaces the single best combo on each axis, so a
// "best win rate" claim can never quietly hide a worse equity path.

import {
  runBreakoutBacktest,
  type BreakoutBacktestConfig,
  type CohortStats,
  type SymbolBars,
} from "@/lib/breakout-backtest";
import type { RegimeLabel } from "@/lib/regime-walk-forward";
import type { SweepParams } from "@/lib/breakout-param-sweep";

export type ExitParams = {
  /** Stop distance in ATRs. */
  stopAtr: number;
  /** Profit target in ATRs. */
  targetAtr: number;
  /** Max bars held before a time exit. */
  horizonBars: number;
};

export type ExitSweepGrid = {
  stopAtr: readonly number[];
  targetAtr: readonly number[];
  horizonBars: readonly number[];
};

/** 1–3 ATR stops against 2–5 ATR targets, at the live 10-bar horizon. */
export const DEFAULT_EXIT_SWEEP_GRID: ExitSweepGrid = {
  stopAtr: [1, 1.5, 2, 2.5, 3],
  targetAtr: [2, 2.5, 3, 4, 5],
  horizonBars: [10],
};

export type ExitCohortEdge = {
  trades: number;
  winRatePct: number;
  avgReturnPct: number;
  expectancyPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  avgBarsHeld: number;
};

export type ExitSweepResult = {
  params: ExitParams;
  /** Reward:risk implied by the stop/target pair. */
  rewardRisk: number;
  confirmed: ExitCohortEdge;
  failed: ExitCohortEdge;
  /** Confirmed-cohort edge per regime. */
  byRegime: Record<RegimeLabel, ExitCohortEdge>;
  winRateGapPp: number;
  avgReturnGapPct: number;
  /** Blended objective; higher is better. */
  score: number;
  /** Set when the confirmed sample was too small to rank. */
  disqualified: string | null;
};

export type ExitSweepObjective = {
  minConfirmedTrades: number;
  /** Weight per percentage point of confirmed win rate. */
  winRateWeight: number;
  /** Weight per 1% of confirmed max drawdown (drawdown is negative). */
  drawdownWeight: number;
  /** Weight per 1% of confirmed expectancy. */
  expectancyWeight: number;
};

export const DEFAULT_EXIT_SWEEP_OBJECTIVE: ExitSweepObjective = {
  minConfirmedTrades: 25,
  winRateWeight: 1,
  drawdownWeight: 0.35,
  expectancyWeight: 20,
};

export type BreakoutExitSweepReport = {
  gridSize: number;
  symbols: string[];
  from: string | null;
  to: string | null;
  /** Detector settings held fixed for the whole sweep. */
  detector: Partial<SweepParams>;
  costBps: number;
  /** Live configuration's row, always present for comparison. */
  baseline: ExitSweepResult;
  /** Ranked by the blended objective, best first; disqualified rows excluded. */
  results: ExitSweepResult[];
  /** Per-axis winners, so the headline can't hide a trade-off. */
  bestWinRate: ExitSweepResult | null;
  bestDrawdown: ExitSweepResult | null;
  bestExpectancy: ExitSweepResult | null;
  bestBlended: ExitSweepResult | null;
  notes: string[];
};

export type ExitSweepOptions = {
  grid?: Partial<ExitSweepGrid>;
  objective?: Partial<ExitSweepObjective>;
  /** Detector overrides held fixed across the sweep. */
  detector?: Partial<SweepParams>;
  costBps?: number;
  warmupBars?: number;
  /** Live exit settings used for the baseline row. */
  baseline?: ExitParams;
  onProgress?: (done: number, total: number) => void;
};

export const LIVE_EXIT_PARAMS: ExitParams = { stopAtr: 2, targetAtr: 3, horizonBars: 10 };

const REGIMES: readonly RegimeLabel[] = ["bull", "bear", "sideways"];

const EMPTY_EDGE: ExitCohortEdge = {
  trades: 0,
  winRatePct: 0,
  avgReturnPct: 0,
  expectancyPct: 0,
  maxDrawdownPct: 0,
  profitFactor: null,
  avgBarsHeld: 0,
};

function edgeOf(stats: CohortStats | undefined): ExitCohortEdge {
  if (!stats) return { ...EMPTY_EDGE };
  return {
    trades: stats.trades,
    winRatePct: stats.winRatePct,
    avgReturnPct: stats.avgReturnPct,
    expectancyPct: stats.expectancyPct,
    maxDrawdownPct: stats.maxDrawdownPct,
    profitFactor: stats.profitFactor,
    avgBarsHeld: stats.avgBarsHeld,
  };
}

export function exitParamKey(p: ExitParams): string {
  return `stop=${p.stopAtr}|target=${p.targetAtr}|horizon=${p.horizonBars}`;
}

/** Cartesian product of the exit grid; the baseline combo is pulled to the front. */
export function expandExitGrid(grid: ExitSweepGrid, baseline = LIVE_EXIT_PARAMS): ExitParams[] {
  if (!grid.stopAtr.length || !grid.targetAtr.length || !grid.horizonBars.length) {
    throw new Error("Exit sweep grid has an empty axis");
  }
  const combos: ExitParams[] = [];
  const seen = new Set<string>();
  for (const stopAtr of grid.stopAtr) {
    for (const targetAtr of grid.targetAtr) {
      for (const horizonBars of grid.horizonBars) {
        const p = { stopAtr, targetAtr, horizonBars };
        const k = exitParamKey(p);
        if (seen.has(k)) continue;
        seen.add(k);
        combos.push(p);
      }
    }
  }
  const baseKey = exitParamKey(baseline);
  combos.sort((a, b) => Number(exitParamKey(b) === baseKey) - Number(exitParamKey(a) === baseKey));
  return combos;
}

/**
 * Blended objective. Win rate leads (that's the stated goal), drawdown relief
 * is a real credit, and expectancy is weighted heavily enough that a combo
 * cannot win by hitting a lot of tiny targets while losing money overall.
 */
export function scoreExit(r: Pick<ExitSweepResult, "confirmed">, obj: ExitSweepObjective): number {
  const c = r.confirmed;
  return (
    obj.winRateWeight * c.winRatePct +
    obj.drawdownWeight * c.maxDrawdownPct + // negative → penalty
    obj.expectancyWeight * c.expectancyPct
  );
}

/** Run the breakout backtest once per stop/target/horizon combination. */
export function runBreakoutExitSweep(
  series: readonly SymbolBars[],
  options: ExitSweepOptions = {},
): BreakoutExitSweepReport {
  const grid: ExitSweepGrid = { ...DEFAULT_EXIT_SWEEP_GRID, ...options.grid };
  const objective: ExitSweepObjective = { ...DEFAULT_EXIT_SWEEP_OBJECTIVE, ...options.objective };
  const baselineParams = options.baseline ?? LIVE_EXIT_PARAMS;
  const costBps = options.costBps ?? 20;
  const detector = options.detector ?? {};
  const combos = expandExitGrid(grid, baselineParams);

  let from: string | null = null;
  let to: string | null = null;

  const evaluate = (params: ExitParams): ExitSweepResult => {
    const cfg: Partial<BreakoutBacktestConfig> = {
      stopAtr: params.stopAtr,
      targetAtr: params.targetAtr,
      horizonBars: params.horizonBars,
      costBps,
      detector,
      ...(options.warmupBars != null ? { warmupBars: options.warmupBars } : {}),
    };
    const report = runBreakoutBacktest(series, cfg);
    if (report.from && (!from || report.from < from)) from = report.from;
    if (report.to && (!to || report.to > to)) to = report.to;

    const confirmed = edgeOf(report.stats.find((s) => s.cohort === "confirmed" && s.regime === "all"));
    const failed = edgeOf(report.stats.find((s) => s.cohort === "failed" && s.regime === "all"));
    const byRegime = {} as Record<RegimeLabel, ExitCohortEdge>;
    for (const r of REGIMES) {
      byRegime[r] = edgeOf(report.stats.find((s) => s.cohort === "confirmed" && s.regime === r));
    }

    const disqualified =
      confirmed.trades < objective.minConfirmedTrades
        ? `only ${confirmed.trades} confirmed signals (need ${objective.minConfirmedTrades})`
        : null;

    const base: Pick<ExitSweepResult, "confirmed"> = { confirmed };
    return {
      params,
      rewardRisk: params.stopAtr > 0 ? params.targetAtr / params.stopAtr : Infinity,
      confirmed,
      failed,
      byRegime,
      winRateGapPp: confirmed.winRatePct - failed.winRatePct,
      avgReturnGapPct: confirmed.avgReturnPct - failed.avgReturnPct,
      score: disqualified ? -Infinity : scoreExit(base, objective),
      disqualified,
    };
  };

  const all: ExitSweepResult[] = [];
  let done = 0;
  for (const p of combos) {
    all.push(evaluate(p));
    options.onProgress?.(++done, combos.length);
  }

  const baseKey = exitParamKey(baselineParams);
  const baseline = all.find((r) => exitParamKey(r.params) === baseKey) ?? evaluate(baselineParams);

  const ranked = all.filter((r) => !r.disqualified).sort((a, b) => b.score - a.score);
  const pick = (cmp: (a: ExitSweepResult, b: ExitSweepResult) => number) =>
    ranked.length ? [...ranked].sort(cmp)[0]! : null;

  const bestWinRate = pick((a, b) => b.confirmed.winRatePct - a.confirmed.winRatePct);
  const bestDrawdown = pick((a, b) => b.confirmed.maxDrawdownPct - a.confirmed.maxDrawdownPct);
  const bestExpectancy = pick((a, b) => b.confirmed.expectancyPct - a.confirmed.expectancyPct);
  const bestBlended = ranked[0] ?? null;

  const notes: string[] = [];
  const fmt = (r: ExitSweepResult) =>
    `${r.params.stopAtr} ATR stop / ${r.params.targetAtr} ATR target (${r.params.horizonBars}b)`;
  if (bestWinRate) {
    notes.push(
      `Highest win rate: ${fmt(bestWinRate)} at ${bestWinRate.confirmed.winRatePct.toFixed(1)}% over ${bestWinRate.confirmed.trades} confirmed signals (avg ${bestWinRate.confirmed.avgReturnPct.toFixed(2)}%, drawdown ${bestWinRate.confirmed.maxDrawdownPct.toFixed(1)}%).`,
    );
  }
  if (bestDrawdown) {
    notes.push(
      `Shallowest drawdown: ${fmt(bestDrawdown)} at ${bestDrawdown.confirmed.maxDrawdownPct.toFixed(1)}% versus ${baseline.confirmed.maxDrawdownPct.toFixed(1)}% live — win rate ${bestDrawdown.confirmed.winRatePct.toFixed(1)}%.`,
    );
  }
  if (bestExpectancy && bestExpectancy.confirmed.expectancyPct <= 0) {
    notes.push(
      `No combination made the confirmed cohort profitable — best expectancy is ${bestExpectancy.confirmed.expectancyPct.toFixed(2)}% at ${fmt(bestExpectancy)}. Better exits reduce the bleed; they do not create an edge.`,
    );
  } else if (bestExpectancy) {
    notes.push(
      `Best expectancy: ${fmt(bestExpectancy)} at ${bestExpectancy.confirmed.expectancyPct.toFixed(2)}% per confirmed signal.`,
    );
  }
  if (bestWinRate && bestExpectancy && exitParamKey(bestWinRate.params) !== exitParamKey(bestExpectancy.params)) {
    notes.push(
      `Win rate and expectancy disagree: the highest hit rate comes from a nearer target, which caps the winners. Prefer the blended pick unless you specifically want hit rate.`,
    );
  }
  const thin = all.filter((r) => r.disqualified).length;
  if (thin) notes.push(`${thin} of ${combos.length} combinations had too few confirmed signals to rank.`);

  return {
    gridSize: combos.length,
    symbols: series.map((s) => s.symbol),
    from,
    to,
    detector,
    costBps,
    baseline,
    results: ranked,
    bestWinRate,
    bestDrawdown,
    bestExpectancy,
    bestBlended,
    notes,
  };
}

/** Win-rate / drawdown matrix over the stop × target plane, for heatmap UIs. */
export function exitHeatmap(
  report: BreakoutExitSweepReport,
  metric: "winRatePct" | "maxDrawdownPct" | "expectancyPct" | "avgReturnPct",
): { stops: number[]; targets: number[]; cells: (number | null)[][] } {
  const stops = [...new Set(report.results.concat(report.baseline).map((r) => r.params.stopAtr))].sort(
    (a, b) => a - b,
  );
  const targets = [
    ...new Set(report.results.concat(report.baseline).map((r) => r.params.targetAtr)),
  ].sort((a, b) => a - b);
  const cells = stops.map((s) =>
    targets.map((t) => {
      const hit = report.results.find((r) => r.params.stopAtr === s && r.params.targetAtr === t);
      return hit ? hit.confirmed[metric] : null;
    }),
  );
  return { stops, targets, cells };
}

/** Plain-text summary for CLI/report use. */
export function formatExitSweepReport(report: BreakoutExitSweepReport, topN = 12): string {
  const lines: string[] = [];
  lines.push(
    `BREAKOUT EXIT SWEEP — ${report.gridSize} stop/target combos, ${report.symbols.length} symbols, ${report.from ?? "?"} → ${report.to ?? "?"}, ${report.costBps}bps costs`,
  );
  const row = (r: ExitSweepResult, tag: string) =>
    `  ${tag.padEnd(9)} stop=${String(r.params.stopAtr).padStart(4)} tgt=${String(r.params.targetAtr).padStart(4)} R:R=${r.rewardRisk.toFixed(2)} | n=${String(r.confirmed.trades).padStart(4)} win=${r.confirmed.winRatePct.toFixed(1)}% avg=${r.confirmed.avgReturnPct.toFixed(2)}% exp=${r.confirmed.expectancyPct.toFixed(2)}% dd=${r.confirmed.maxDrawdownPct.toFixed(1)}% held=${r.confirmed.avgBarsHeld.toFixed(1)}b`;
  lines.push(row(report.baseline, "live"));
  for (const r of report.results.slice(0, topN)) lines.push(row(r, ""));
  if (report.bestWinRate) lines.push(row(report.bestWinRate, "bestWin"));
  if (report.bestDrawdown) lines.push(row(report.bestDrawdown, "bestDD"));
  if (report.bestExpectancy) lines.push(row(report.bestExpectancy, "bestExp"));
  for (const n of report.notes) lines.push(`  - ${n}`);
  return lines.join("\n");
}
