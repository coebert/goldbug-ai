// Walk-forward evaluation engine.
//
// For each fold produced by `buildWalkForwardFolds` we:
//   1. run the rule-based long-horizon backtest over the TRAIN window once per
//      parameter combination in a small grid,
//   2. pick the winning combination on the training slice only,
//   3. re-run that single combination over the untouched TEST window,
//   4. keep the SPY benchmark over the same test window for comparison.
//
// The result is an out-of-sample track record plus an over-fitting diagnostic,
// which is the check you want before handing the strategy to the live autopilot.

import type { Database } from "@/integrations/supabase/types";
import {
  buildWalkForwardFolds,
  selectBestParams,
  summariseWalkForward,
  stitchOutOfSampleCurve,
  EMPTY_FOLD_METRICS,
  type FoldMetrics,
  type FoldOutcome,
  type SelectionObjective,
  type WalkForwardMode,
  type WalkForwardSummary,
} from "./walk-forward";
import {
  assessHoldout,
  buildFoldsWithHoldout,
  withHoldout,
  type DateWindow,
  type HoldoutSegmentResult,
  type SummaryWithHoldout,
} from "./walk-forward-holdout";

export type WalkForwardParams = {
  rebalance: "monthly" | "quarterly";
  top_k: number;
};

export type WalkForwardFoldReport = {
  index: number;
  train: { from: string; to: string };
  test: { from: string; to: string };
  params: WalkForwardParams;
  inSample: FoldMetrics;
  outOfSample: FoldMetrics;
  benchmark: FoldMetrics | null;
  /** Grid results on the training slice (for transparency in the UI). */
  grid: Array<{ params: WalkForwardParams; sharpe: number; totalReturnPct: number }>;
};

export type WalkForwardReport = {
  from: string;
  to: string;
  mode: WalkForwardMode;
  train_days: number;
  test_days: number;
  objective: SelectionObjective;
  currency: string;
  starting_cash: number;
  folds: WalkForwardFoldReport[];
  oos_curve: Array<{ date: string; value: number; foldIndex: number }>;
  summary: SummaryWithHoldout;
  /** Days reserved at the end of history that folds were never allowed to see. */
  holdout_days: number;
  /** Params frozen after walk-forward and replayed over the holdout. */
  holdout_params: WalkForwardParams | null;
  holdout_segments: Array<{
    index: number;
    window: DateWindow;
    metrics: FoldMetrics;
    benchmark: FoldMetrics | null;
  }>;
  holdout_note?: string;
};

/**
 * Freeze one parameter set for the holdout: the combination walk-forward chose
 * most often, tie-broken by mean out-of-sample Sharpe. Using the last fold's
 * winner alone would let one noisy window pick the frozen strategy.
 */
function freezeParams(
  outcomes: Array<FoldOutcome<WalkForwardParams>>,
): WalkForwardParams | null {
  if (!outcomes.length) return null;
  const buckets = new Map<string, { params: WalkForwardParams; n: number; sharpe: number }>();
  for (const o of outcomes) {
    const key = `${o.params.rebalance}|${o.params.top_k}`;
    const b = buckets.get(key) ?? { params: o.params, n: 0, sharpe: 0 };
    b.n += 1;
    b.sharpe += o.outOfSample.sharpe;
    buckets.set(key, b);
  }
  const ranked = [...buckets.values()].sort(
    (a, b) => b.n - a.n || b.sharpe / b.n - a.sharpe / a.n,
  );
  return ranked[0]?.params ?? null;
}

const DEFAULT_GRID: WalkForwardParams[] = [
  { rebalance: "monthly", top_k: 4 },
  { rebalance: "monthly", top_k: 6 },
  { rebalance: "monthly", top_k: 8 },
  { rebalance: "quarterly", top_k: 6 },
];

function toFoldMetrics(m: {
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  volatilityPct: number;
  days: number;
} | undefined): FoldMetrics {
  if (!m) return { ...EMPTY_FOLD_METRICS };
  return {
    totalReturnPct: m.totalReturnPct,
    cagrPct: m.cagrPct,
    maxDrawdownPct: m.maxDrawdownPct,
    sharpe: m.sharpe,
    volatilityPct: m.volatilityPct,
    days: m.days,
  };
}

export async function runWalkForwardEvaluation(opts: {
  from: string;
  to: string;
  startingCash: number;
  currency: string;
  riskLevel: Database["public"]["Enums"]["risk_level"];
  riskConfig: unknown;
  trainDays: number;
  testDays: number;
  mode?: WalkForwardMode;
  maxFolds?: number;
  objective?: SelectionObjective;
  grid?: WalkForwardParams[];
  /** Calendar days carved off the end of history before folds are built. */
  holdoutDays?: number;
  holdoutSegmentDays?: number;
  execution?: { commission_bps?: number; slippage_bps?: number; min_trade_value?: number };
}): Promise<WalkForwardReport> {
  const { runLongHorizonBacktest, LONG_HORIZON_UNIVERSE } = await import("./long-horizon.server");
  const mode: WalkForwardMode = opts.mode ?? "rolling";
  const objective: SelectionObjective = opts.objective ?? "sharpe";
  const grid = opts.grid && opts.grid.length > 0 ? opts.grid : DEFAULT_GRID;

  const holdoutDays = Math.max(0, opts.holdoutDays ?? 0);
  const { folds, split } = buildFoldsWithHoldout({
    from: opts.from,
    to: opts.to,
    trainDays: opts.trainDays,
    testDays: opts.testDays,
    mode,
    maxFolds: opts.maxFolds ?? 12,
    holdoutDays,
    ...(opts.holdoutSegmentDays === undefined ? {} : { segmentDays: opts.holdoutSegmentDays }),
  });

  const runWindow = async (window: { from: string; to: string }, params: WalkForwardParams) =>
    runLongHorizonBacktest({
      from: window.from,
      to: window.to,
      startingCash: opts.startingCash,
      currency: opts.currency,
      riskLevel: opts.riskLevel,
      riskConfig: opts.riskConfig,
      universe: LONG_HORIZON_UNIVERSE,
      rebalance: params.rebalance,
      topK: params.top_k,
      execution: opts.execution,
    });

  const reports: WalkForwardFoldReport[] = [];
  const outcomes: Array<FoldOutcome<WalkForwardParams>> = [];
  const oosCurves: Array<{ index: number; curve: Array<{ date: string; value: number }> }> = [];

  for (const fold of folds) {
    // 1–2. Train: score the whole grid in-sample, pick a winner.
    const candidates: Array<{ params: WalkForwardParams; metrics: FoldMetrics }> = [];
    for (const params of grid) {
      try {
        const res = await runWindow(fold.train, params);
        const strat = res.series.find((s) => s.key === "aegis");
        if (!strat || strat.curve.length < 2) continue;
        candidates.push({ params, metrics: toFoldMetrics(strat.metrics) });
      } catch (err) {
        console.warn(`walk-forward: train fold ${fold.index} ${JSON.stringify(params)} failed`, err);
      }
    }
    const best = selectBestParams(candidates, objective);
    if (!best) continue;

    // 3–4. Test: same params, untouched window, plus the SPY benchmark.
    let outOfSample: FoldMetrics = { ...EMPTY_FOLD_METRICS };
    let benchmark: FoldMetrics | null = null;
    try {
      const res = await runWindow(fold.test, best.params);
      const strat = res.series.find((s) => s.key === "aegis");
      const spy = res.series.find((s) => s.key === "spy");
      if (!strat || strat.curve.length < 2) continue;
      outOfSample = toFoldMetrics(strat.metrics);
      benchmark = spy ? toFoldMetrics(spy.metrics) : null;
      oosCurves.push({ index: fold.index, curve: strat.curve });
    } catch (err) {
      console.warn(`walk-forward: test fold ${fold.index} failed`, err);
      continue;
    }

    outcomes.push({
      fold,
      params: best.params,
      inSample: best.metrics,
      outOfSample,
      benchmark,
    });
    reports.push({
      index: fold.index,
      train: fold.train,
      test: fold.test,
      params: best.params,
      inSample: best.metrics,
      outOfSample,
      benchmark,
      grid: candidates.map((c) => ({
        params: c.params,
        sharpe: Number(c.metrics.sharpe.toFixed(2)),
        totalReturnPct: Number(c.metrics.totalReturnPct.toFixed(2)),
      })),
    });
  }

  // Holdout: freeze one parameter set, replay it over tape no fold ever saw.
  const summary = summariseWalkForward(outcomes);
  const frozen = freezeParams(outcomes);
  const segmentResults: HoldoutSegmentResult[] = [];
  if (frozen && split.holdout) {
    for (const [i, window] of split.segments.entries()) {
      try {
        const res = await runWindow(window, frozen);
        const strat = res.series.find((s) => s.key === "aegis");
        const spy = res.series.find((s) => s.key === "spy");
        if (!strat || strat.curve.length < 2) continue;
        segmentResults.push({
          index: i,
          window,
          metrics: toFoldMetrics(strat.metrics),
          benchmark: spy ? toFoldMetrics(spy.metrics) : null,
        });
      } catch (err) {
        console.warn(`walk-forward: holdout segment ${i} failed`, err);
      }
    }
  }
  const holdout = assessHoldout(segmentResults, outcomes.length ? summary : null);

  return {
    from: opts.from,
    to: opts.to,
    mode,
    train_days: opts.trainDays,
    test_days: opts.testDays,
    objective,
    currency: opts.currency,
    starting_cash: opts.startingCash,
    folds: reports,
    oos_curve: stitchOutOfSampleCurve(oosCurves, opts.startingCash),
    summary: withHoldout(summary, holdout),
    holdout_days: holdoutDays,
    holdout_params: frozen,
    holdout_segments: segmentResults.map((s) => ({
      index: s.index,
      window: s.window,
      metrics: s.metrics,
      benchmark: s.benchmark ?? null,
    })),
    ...(split.note ? { holdout_note: split.note } : {}),
  };
}
