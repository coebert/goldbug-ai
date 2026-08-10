// Automatic parameter sweep for the breakout detector.
//
// The Aug-2026 end-to-end backtest returned `not_supported` for the shipped
// defaults (55-bar channel, 20-bar base, 18% base width, 0.25 ATR penetration,
// 1.4x volume). Rather than hand-tuning those numbers until the report goes
// green — which is just overfitting with extra steps — this module sweeps the
// grid systematically and judges every candidate on a HOLDOUT slice it never
// scored during ranking.
//
// Rules of the road:
//   * Candidates with too few confirmed signals are disqualified, not ranked
//     low: a 3-trade +8% cohort is noise, not an edge.
//   * The objective rewards the confirmed cohort's own net return first and
//     its edge over the failed cohort second, with an explicit drawdown
//     penalty so a fragile equity path can't win on averages.
//   * A winner is only "accepted" when the holdout also shows a positive
//     confirmed return. Train-only wins come back as `overfit`.

import { DEFAULT_BREAKOUT_CONFIG, type BreakoutConfig } from "@/lib/alpha/breakout";
import {
  runBreakoutBacktest,
  type BreakoutBacktestConfig,
  type SymbolBars,
} from "@/lib/breakout-backtest";

/** The detector knobs this sweep is allowed to move. */
export type SweepParams = Pick<
  BreakoutConfig,
  "channelBars" | "minBaseBars" | "maxBasePct" | "minPenetrationAtr" | "minVolumeRatio"
>;

export type SweepGrid = { [K in keyof SweepParams]: readonly number[] };

/**
 * Default grid — 3 x 3 x 3 x 4 x 4 = 432 combinations, bracketing the shipped
 * defaults on both sides so the sweep can loosen or tighten each filter.
 */
export const DEFAULT_SWEEP_GRID: SweepGrid = {
  channelBars: [20, 34, 55],
  minBaseBars: [10, 20, 30],
  maxBasePct: [0.1, 0.18, 0.28],
  minPenetrationAtr: [0, 0.25, 0.5, 0.9],
  minVolumeRatio: [1, 1.4, 1.8, 2.4],
};

export type SweepObjective = {
  /** Confirmed signals required on BOTH slices before a candidate can rank. */
  minConfirmedTrades: number;
  /** Weight on the confirmed cohort's own average net return. */
  returnWeight: number;
  /** Weight on (confirmed − failed) average return, i.e. the discriminative edge. */
  edgeWeight: number;
  /** Weight on (confirmed − failed) win-rate gap, in percentage points. */
  winRateWeight: number;
  /** Penalty per 1% of confirmed-cohort max drawdown. */
  drawdownPenalty: number;
  /** Fraction of the date range used for training; the rest is holdout. */
  trainFraction: number;
};

export const DEFAULT_SWEEP_OBJECTIVE: SweepObjective = {
  minConfirmedTrades: 25,
  returnWeight: 1,
  edgeWeight: 0.5,
  winRateWeight: 0.02,
  drawdownPenalty: 0.01,
  trainFraction: 0.7,
};

export type SliceEdge = {
  signals: number;
  confirmedTrades: number;
  failedTrades: number;
  confirmedWinRatePct: number;
  confirmedAvgReturnPct: number;
  confirmedExpectancyPct: number;
  confirmedMaxDrawdownPct: number;
  failedAvgReturnPct: number;
  avgReturnGapPct: number;
  winRateGapPp: number;
};

export type SweepCandidateResult = {
  params: SweepParams;
  train: SliceEdge;
  holdout: SliceEdge | null;
  /** Objective value on the train slice. Disqualified candidates score -Infinity. */
  score: number;
  /** Why a candidate was dropped from the ranking, if it was. */
  disqualified: string | null;
  /**
   * `accepted`  — positive confirmed return on train AND holdout.
   * `overfit`   — train positive, holdout not.
   * `rejected`  — no positive confirmed return on train.
   * `thin`      — disqualified on sample size.
   */
  status: "accepted" | "overfit" | "rejected" | "thin";
};

export type BreakoutParamSweepReport = {
  gridSize: number;
  evaluated: number;
  trainRange: { from: string; to: string } | null;
  holdoutRange: { from: string; to: string } | null;
  /** Shipped-defaults candidate, always evaluated for comparison. */
  baseline: SweepCandidateResult;
  /** Ranked best-first; disqualified candidates are excluded. */
  results: SweepCandidateResult[];
  /** Best candidate whose holdout also held up, if any. */
  best: SweepCandidateResult | null;
  verdict: "found_positive_edge" | "train_only" | "no_positive_edge";
  notes: string[];
};

export type SweepOptions = {
  grid?: Partial<SweepGrid>;
  objective?: Partial<SweepObjective>;
  /** Backtest settings (horizon/stop/target/costs) held fixed across the sweep. */
  backtest?: Partial<Omit<BreakoutBacktestConfig, "detector">>;
  /** Hard cap on combinations evaluated, to bound runtime. */
  maxCandidates?: number;
  /** Called after each candidate — for progress reporting on long sweeps. */
  onProgress?: (done: number, total: number) => void;
};

const KEYS: readonly (keyof SweepParams)[] = [
  "channelBars",
  "minBaseBars",
  "maxBasePct",
  "minPenetrationAtr",
  "minVolumeRatio",
];

/** Cartesian product of the grid, defaults first so it's never truncated away. */
export function expandGrid(grid: SweepGrid, maxCandidates = Infinity): SweepParams[] {
  let combos: SweepParams[] = [{} as SweepParams];
  for (const key of KEYS) {
    const values = grid[key];
    if (!values.length) throw new Error(`Sweep grid axis "${key}" is empty`);
    const next: SweepParams[] = [];
    for (const base of combos) {
      for (const v of values) next.push({ ...base, [key]: v });
    }
    combos = next;
  }
  // De-duplicate (a grid may repeat a value) and pull the shipped defaults to
  // the front so the cap can never drop the baseline comparison.
  const seen = new Set<string>();
  const unique: SweepParams[] = [];
  for (const c of combos) {
    const k = paramKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(c);
  }
  const baseKey = paramKey(baselineParams());
  unique.sort((a, b) => Number(paramKey(b) === baseKey) - Number(paramKey(a) === baseKey));
  return Number.isFinite(maxCandidates) ? unique.slice(0, maxCandidates) : unique;
}

export function paramKey(p: SweepParams): string {
  return KEYS.map((k) => `${k}=${p[k]}`).join("|");
}

export function baselineParams(): SweepParams {
  return {
    channelBars: DEFAULT_BREAKOUT_CONFIG.channelBars,
    minBaseBars: DEFAULT_BREAKOUT_CONFIG.minBaseBars,
    maxBasePct: DEFAULT_BREAKOUT_CONFIG.maxBasePct,
    minPenetrationAtr: DEFAULT_BREAKOUT_CONFIG.minPenetrationAtr,
    minVolumeRatio: DEFAULT_BREAKOUT_CONFIG.minVolumeRatio,
  };
}

/** All dates present across the series, ascending and de-duplicated. */
export function seriesDates(series: readonly SymbolBars[]): string[] {
  const set = new Set<string>();
  for (const s of series) for (const b of s.bars) set.add(b.date);
  return [...set].sort();
}

/**
 * Chronological train/holdout split. The split is by DATE, not by row, so
 * every symbol is cut at the same moment and no candidate can be ranked on
 * data that also appears in its holdout.
 */
export function splitSeries(
  series: readonly SymbolBars[],
  trainFraction: number,
): {
  train: SymbolBars[];
  holdout: SymbolBars[];
  trainRange: { from: string; to: string } | null;
  holdoutRange: { from: string; to: string } | null;
} {
  const dates = seriesDates(series);
  if (dates.length < 2 || trainFraction >= 1 || trainFraction <= 0) {
    return {
      train: series.map((s) => ({ ...s, bars: [...s.bars] })),
      holdout: [],
      trainRange: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
      holdoutRange: null,
    };
  }
  const cutIdx = Math.max(1, Math.min(dates.length - 1, Math.floor(dates.length * trainFraction)));
  const cut = dates[cutIdx]!;
  const train = series.map((s) => ({ symbol: s.symbol, bars: s.bars.filter((b) => b.date < cut) }));
  const holdout = series.map((s) => ({ symbol: s.symbol, bars: s.bars.filter((b) => b.date >= cut) }));
  return {
    train,
    holdout,
    trainRange: { from: dates[0]!, to: dates[cutIdx - 1]! },
    holdoutRange: { from: cut, to: dates[dates.length - 1]! },
  };
}

function edgeFor(
  series: readonly SymbolBars[],
  params: SweepParams,
  backtest: Partial<Omit<BreakoutBacktestConfig, "detector">>,
): SliceEdge {
  const report = runBreakoutBacktest(series, { ...backtest, detector: params });
  const confirmed = report.stats.find((s) => s.cohort === "confirmed" && s.regime === "all");
  const failed = report.stats.find((s) => s.cohort === "failed" && s.regime === "all");
  return {
    signals: report.trades.length,
    confirmedTrades: confirmed?.trades ?? 0,
    failedTrades: failed?.trades ?? 0,
    confirmedWinRatePct: confirmed?.winRatePct ?? 0,
    confirmedAvgReturnPct: confirmed?.avgReturnPct ?? 0,
    confirmedExpectancyPct: confirmed?.expectancyPct ?? 0,
    confirmedMaxDrawdownPct: confirmed?.maxDrawdownPct ?? 0,
    failedAvgReturnPct: failed?.avgReturnPct ?? 0,
    avgReturnGapPct: (confirmed?.avgReturnPct ?? 0) - (failed?.avgReturnPct ?? 0),
    winRateGapPp: (confirmed?.winRatePct ?? 0) - (failed?.winRatePct ?? 0),
  };
}

/** Objective value for one slice. Higher is better. */
export function scoreEdge(edge: SliceEdge, obj: SweepObjective): number {
  return (
    obj.returnWeight * edge.confirmedAvgReturnPct +
    obj.edgeWeight * edge.avgReturnGapPct +
    obj.winRateWeight * edge.winRateGapPp +
    obj.drawdownPenalty * edge.confirmedMaxDrawdownPct // drawdown is <= 0
  );
}

/**
 * Sweep the detector grid and report which settings — if any — give the
 * confirmed cohort a positive net return edge that survives a holdout.
 */
export function runBreakoutParamSweep(
  series: readonly SymbolBars[],
  options: SweepOptions = {},
): BreakoutParamSweepReport {
  const grid: SweepGrid = { ...DEFAULT_SWEEP_GRID, ...options.grid };
  const objective: SweepObjective = { ...DEFAULT_SWEEP_OBJECTIVE, ...options.objective };
  const backtest = options.backtest ?? {};
  const candidates = expandGrid(grid, options.maxCandidates ?? Infinity);
  const { train, holdout, trainRange, holdoutRange } = splitSeries(series, objective.trainFraction);
  const hasHoldout = holdout.some((s) => s.bars.length > 0);

  const evaluate = (params: SweepParams): SweepCandidateResult => {
    const trainEdge = edgeFor(train, params, backtest);
    let disqualified: string | null = null;
    if (trainEdge.confirmedTrades < objective.minConfirmedTrades) {
      disqualified = `only ${trainEdge.confirmedTrades} confirmed signals in training (need ${objective.minConfirmedTrades})`;
    }
    const holdoutEdge = hasHoldout && !disqualified ? edgeFor(holdout, params, backtest) : null;

    let status: SweepCandidateResult["status"];
    if (disqualified) status = "thin";
    else if (trainEdge.confirmedAvgReturnPct <= 0) status = "rejected";
    else if (!holdoutEdge || holdoutEdge.confirmedAvgReturnPct <= 0) status = "overfit";
    else status = "accepted";

    return {
      params,
      train: trainEdge,
      holdout: holdoutEdge,
      score: disqualified ? -Infinity : scoreEdge(trainEdge, objective),
      disqualified,
      status,
    };
  };

  const all: SweepCandidateResult[] = [];
  let done = 0;
  for (const params of candidates) {
    all.push(evaluate(params));
    options.onProgress?.(++done, candidates.length);
  }

  const baseKey = paramKey(baselineParams());
  const baseline =
    all.find((r) => paramKey(r.params) === baseKey) ?? evaluate(baselineParams());

  const results = all
    .filter((r) => !r.disqualified)
    .sort((a, b) => b.score - a.score);

  const best = results.find((r) => r.status === "accepted") ?? null;
  const trainOnly = results.find((r) => r.status === "overfit") ?? null;

  const notes: string[] = [];
  let verdict: BreakoutParamSweepReport["verdict"];
  if (best) {
    verdict = "found_positive_edge";
    notes.push(
      `Best surviving settings: channel ${best.params.channelBars}b, base >=${best.params.minBaseBars}b <=${(best.params.maxBasePct * 100).toFixed(0)}%, penetration ${best.params.minPenetrationAtr} ATR, volume ${best.params.minVolumeRatio}x — confirmed avg ${best.train.confirmedAvgReturnPct.toFixed(2)}% train / ${best.holdout!.confirmedAvgReturnPct.toFixed(2)}% holdout.`,
    );
  } else if (trainOnly) {
    verdict = "train_only";
    notes.push(
      `No settings survived the holdout. Best in-sample candidate (channel ${trainOnly.params.channelBars}b, penetration ${trainOnly.params.minPenetrationAtr} ATR, volume ${trainOnly.params.minVolumeRatio}x) earned ${trainOnly.train.confirmedAvgReturnPct.toFixed(2)}% in training but ${trainOnly.holdout ? `${trainOnly.holdout.confirmedAvgReturnPct.toFixed(2)}%` : "nothing"} out of sample — treat as overfit.`,
    );
  } else {
    verdict = "no_positive_edge";
    notes.push(
      `No candidate in ${candidates.length} combinations produced a positive confirmed-cohort net return in training. The breakout edge is absent on this data, not mis-tuned.`,
    );
  }
  notes.push(
    `Baseline (shipped defaults) confirmed avg ${baseline.train.confirmedAvgReturnPct.toFixed(2)}% on ${baseline.train.confirmedTrades} training signals.`,
  );
  const thin = all.filter((r) => r.disqualified).length;
  if (thin) notes.push(`${thin} of ${candidates.length} combinations were too selective to score (thin confirmed sample).`);

  return {
    gridSize: candidates.length,
    evaluated: all.length,
    trainRange,
    holdoutRange,
    baseline,
    results,
    best,
    verdict,
    notes,
  };
}

/** Plain-text summary for CLI/report use. */
export function formatSweepReport(report: BreakoutParamSweepReport, topN = 10): string {
  const lines: string[] = [];
  lines.push(
    `BREAKOUT PARAM SWEEP — ${report.evaluated} combinations, train ${report.trainRange?.from ?? "?"}→${report.trainRange?.to ?? "?"}, holdout ${report.holdoutRange?.from ?? "none"}→${report.holdoutRange?.to ?? ""}`,
  );
  lines.push(
    `  baseline: ch=${report.baseline.params.channelBars} base=${report.baseline.params.minBaseBars}/${report.baseline.params.maxBasePct} pen=${report.baseline.params.minPenetrationAtr} vol=${report.baseline.params.minVolumeRatio} → n=${report.baseline.train.confirmedTrades} avg=${report.baseline.train.confirmedAvgReturnPct.toFixed(2)}% (${report.baseline.status})`,
  );
  for (const r of report.results.slice(0, topN)) {
    lines.push(
      `  ch=${String(r.params.channelBars).padStart(3)} base=${String(r.params.minBaseBars).padStart(2)}/${r.params.maxBasePct} pen=${r.params.minPenetrationAtr} vol=${r.params.minVolumeRatio} | train n=${String(r.train.confirmedTrades).padStart(4)} avg=${r.train.confirmedAvgReturnPct.toFixed(2)}% gap=${r.train.avgReturnGapPct.toFixed(2)}% dd=${r.train.confirmedMaxDrawdownPct.toFixed(1)}% | holdout ${r.holdout ? `n=${r.holdout.confirmedTrades} avg=${r.holdout.confirmedAvgReturnPct.toFixed(2)}%` : "—"} | ${r.status}`,
    );
  }
  lines.push(`VERDICT: ${report.verdict}`);
  for (const n of report.notes) lines.push(`  - ${n}`);
  return lines.join("\n");
}
