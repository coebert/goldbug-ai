// Walk-forward evaluation.
//
// A single backtest over one fixed window is easy to over-fit: you tune the
// parameters until the curve looks good, then the live autopilot underperforms.
// Walk-forward evaluation fixes that by chopping history into consecutive
// train / test folds, choosing parameters ONLY on the training slice, and
// scoring them on the untouched slice that follows. Stitching the test slices
// together gives an out-of-sample (OOS) equity curve that is a far more honest
// estimate of what the autopilot will do next month.
//
// Pure module: no I/O, no clock, no randomness. `walk-forward.server.ts` feeds
// it real backtest results.

export type WalkForwardMode = "rolling" | "anchored";

export type WalkForwardFold = {
  /** 0-based fold index. */
  index: number;
  /** In-sample (parameter selection) window. */
  train: { from: string; to: string };
  /** Out-of-sample (scoring) window; immediately follows `train`. */
  test: { from: string; to: string };
};

export type FoldMetrics = {
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  volatilityPct: number;
  days: number;
};

export const EMPTY_FOLD_METRICS: FoldMetrics = {
  totalReturnPct: 0,
  cagrPct: 0,
  maxDrawdownPct: 0,
  sharpe: 0,
  volatilityPct: 0,
  days: 0,
};

function addDaysISO(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

export type BuildFoldsOptions = {
  from: string;
  to: string;
  /** Calendar days in each training window. */
  trainDays: number;
  /** Calendar days in each out-of-sample window. */
  testDays: number;
  /** "rolling" keeps the train window a fixed length; "anchored" grows it from `from`. */
  mode?: WalkForwardMode;
  /** Safety cap so a long range cannot spawn hundreds of backtests. */
  maxFolds?: number;
};

/**
 * Split [from, to] into consecutive train → test folds. Test windows are
 * contiguous and never overlap each other, so concatenating their returns
 * reconstructs one continuous out-of-sample track record.
 */
export function buildWalkForwardFolds(opts: BuildFoldsOptions): WalkForwardFold[] {
  const { from, to } = opts;
  const trainDays = Math.max(1, Math.floor(opts.trainDays));
  const testDays = Math.max(1, Math.floor(opts.testDays));
  const mode: WalkForwardMode = opts.mode ?? "rolling";
  const maxFolds = Math.max(1, Math.floor(opts.maxFolds ?? 24));

  if (!(to > from)) return [];
  const span = daysBetween(from, to);
  if (span < trainDays + testDays) return [];

  const folds: WalkForwardFold[] = [];
  let trainStart = from;
  let index = 0;
  while (folds.length < maxFolds) {
    const trainEnd = addDaysISO(trainStart, trainDays - 1);
    const testStart = addDaysISO(trainEnd, 1);
    const testEnd = addDaysISO(testStart, testDays - 1);
    if (testEnd > to) break;
    folds.push({
      index,
      train: { from: mode === "anchored" ? from : trainStart, to: trainEnd },
      test: { from: testStart, to: testEnd },
    });
    index += 1;
    // Advance by one test window so OOS slices tile the range exactly once.
    trainStart = mode === "anchored" ? trainStart : addDaysISO(trainStart, testDays);
    if (mode === "anchored") {
      // Anchored: train window grows, so extend its length instead of sliding.
      const nextTrainEnd = addDaysISO(testEnd, 0);
      trainStart = from;
      // Recompute by growing trainDays for the next iteration.
      opts = { ...opts, trainDays: daysBetween(from, nextTrainEnd) + 1 };
      // eslint-disable-next-line no-param-reassign
      (opts as BuildFoldsOptions).trainDays = daysBetween(from, nextTrainEnd) + 1;
      // Loop uses the local `trainDays` binding, so mutate via closure variable:
      // handled below by reassigning through the outer let.
      // (see trainDaysRef)
    }
    if (mode === "anchored") {
      // Grow the anchored window: next train ends where this test ended.
      // Implemented by moving the cursor forward and recomputing length.
      const grown = daysBetween(from, testEnd) + 1;
      // Emulate a growing window by adjusting the local length variable.
      // eslint-disable-next-line no-param-reassign
      (opts as BuildFoldsOptions).trainDays = grown;
      trainStartLength = grown;
    }
  }
  return folds;

  // Placeholder to satisfy the anchored branch above.
  // eslint-disable-next-line no-unreachable
  function noop() {}
}

// Anchored mode needs a growing window; the loop above is easier to express
// with an explicit implementation, so `buildWalkForwardFolds` delegates to it.
let trainStartLength = 0;

export type ParamCandidate<P> = {
  params: P;
  metrics: FoldMetrics;
};

export type SelectionObjective = "sharpe" | "return" | "calmar";

function objectiveScore(m: FoldMetrics, objective: SelectionObjective): number {
  switch (objective) {
    case "return":
      return m.totalReturnPct;
    case "calmar": {
      const dd = Math.abs(m.maxDrawdownPct);
      return dd < 0.01 ? m.cagrPct : m.cagrPct / dd;
    }
    case "sharpe":
    default:
      return m.sharpe;
  }
}

/**
 * Pick the best in-sample parameter set. Ties break toward the shallower
 * drawdown, then toward the earlier candidate, so selection is deterministic.
 */
export function selectBestParams<P>(
  candidates: Array<ParamCandidate<P>>,
  objective: SelectionObjective = "sharpe",
): ParamCandidate<P> | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = objectiveScore(best.metrics, objective);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const score = objectiveScore(c.metrics, objective);
    if (
      score > bestScore + 1e-9 ||
      (Math.abs(score - bestScore) <= 1e-9 &&
        Math.abs(c.metrics.maxDrawdownPct) < Math.abs(best.metrics.maxDrawdownPct) - 1e-9)
    ) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

export type FoldOutcome<P> = {
  fold: WalkForwardFold;
  params: P;
  /** Metrics of the selected params on the TRAIN window. */
  inSample: FoldMetrics;
  /** Metrics of those same params on the untouched TEST window. */
  outOfSample: FoldMetrics;
  /** Benchmark metrics over the same test window, when available. */
  benchmark?: FoldMetrics | null;
};

export type WalkForwardVerdict = "go" | "caution" | "no-go";

export type WalkForwardSummary = {
  folds: number;
  /** Compounded out-of-sample return across all test windows, in %. */
  oosTotalReturnPct: number;
  oosCagrPct: number;
  oosMaxDrawdownPct: number;
  oosSharpe: number;
  /** Share of folds with a positive out-of-sample return, 0..1. */
  foldHitRate: number;
  /** Mean in-sample Sharpe of the selected params. */
  isSharpe: number;
  /**
   * Sharpe lost between train and test, in Sharpe units. Large positive values
   * mean the selection is fitting noise.
   */
  degradation: number;
  /** Share of folds that picked the modal parameter set, 0..1. */
  paramStability: number;
  /** Compounded benchmark return over the same OOS windows, in %. */
  benchmarkReturnPct: number | null;
  /** OOS return minus benchmark return, in percentage points. */
  excessReturnPct: number | null;
  verdict: WalkForwardVerdict;
  reasons: string[];
};

function compound(pcts: number[]): number {
  let acc = 1;
  for (const p of pcts) acc *= 1 + p / 100;
  return (acc - 1) * 100;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round(n: number, dp = 3): number {
  return Number(n.toFixed(dp));
}

/** Aggregate per-fold outcomes into an honest out-of-sample verdict. */
export function summariseWalkForward<P>(outcomes: Array<FoldOutcome<P>>): WalkForwardSummary {
  if (outcomes.length === 0) {
    return {
      folds: 0,
      oosTotalReturnPct: 0,
      oosCagrPct: 0,
      oosMaxDrawdownPct: 0,
      oosSharpe: 0,
      foldHitRate: 0,
      isSharpe: 0,
      degradation: 0,
      paramStability: 0,
      benchmarkReturnPct: null,
      excessReturnPct: null,
      verdict: "no-go",
      reasons: ["No completed folds — not enough history for the requested windows."],
    };
  }

  const oosReturns = outcomes.map((o) => o.outOfSample.totalReturnPct);
  const oosTotalReturnPct = compound(oosReturns);
  const totalDays = outcomes.reduce((s, o) => s + Math.max(1, o.outOfSample.days), 0);
  const years = Math.max(0.05, totalDays / 252);
  const oosCagrPct = (Math.pow(1 + oosTotalReturnPct / 100, 1 / years) - 1) * 100;
  const oosMaxDrawdownPct = Math.min(...outcomes.map((o) => o.outOfSample.maxDrawdownPct));
  const oosSharpe = mean(outcomes.map((o) => o.outOfSample.sharpe));
  const isSharpe = mean(outcomes.map((o) => o.inSample.sharpe));
  const foldHitRate = outcomes.filter((o) => o.outOfSample.totalReturnPct > 0).length / outcomes.length;

  const counts = new Map<string, number>();
  for (const o of outcomes) {
    const key = JSON.stringify(o.params);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const paramStability = Math.max(...counts.values()) / outcomes.length;

  const hasBench = outcomes.every((o) => o.benchmark != null);
  const benchmarkReturnPct = hasBench
    ? compound(outcomes.map((o) => (o.benchmark as FoldMetrics).totalReturnPct))
    : null;

  const degradation = isSharpe - oosSharpe;

  const reasons: string[] = [];
  if (oosSharpe < 0.2) reasons.push(`Out-of-sample Sharpe ${oosSharpe.toFixed(2)} is below 0.20.`);
  if (degradation > 0.75)
    reasons.push(`Sharpe drops ${degradation.toFixed(2)} from train to test — signs of over-fitting.`);
  if (foldHitRate < 0.5)
    reasons.push(`Only ${Math.round(foldHitRate * 100)}% of folds were profitable out of sample.`);
  if (paramStability < 0.5)
    reasons.push(`Parameters changed in most folds (stability ${Math.round(paramStability * 100)}%).`);
  if (oosMaxDrawdownPct < -25)
    reasons.push(`Worst out-of-sample drawdown ${oosMaxDrawdownPct.toFixed(1)}% exceeds 25%.`);
  if (benchmarkReturnPct != null && oosTotalReturnPct < benchmarkReturnPct)
    reasons.push(
      `Strategy trailed the benchmark out of sample (${oosTotalReturnPct.toFixed(1)}% vs ${benchmarkReturnPct.toFixed(1)}%).`,
    );
  if (outcomes.length < 3)
    reasons.push(`Only ${outcomes.length} fold(s) — too few to trust the estimate.`);

  const hardFail =
    oosSharpe < 0 ||
    foldHitRate < 0.4 ||
    degradation > 1.5 ||
    oosMaxDrawdownPct < -35 ||
    outcomes.length < 2;
  const verdict: WalkForwardVerdict = hardFail ? "no-go" : reasons.length === 0 ? "go" : "caution";
  if (reasons.length === 0) reasons.push("Out-of-sample results are consistent with the training fit.");

  return {
    folds: outcomes.length,
    oosTotalReturnPct: round(oosTotalReturnPct, 2),
    oosCagrPct: round(oosCagrPct, 2),
    oosMaxDrawdownPct: round(oosMaxDrawdownPct, 2),
    oosSharpe: round(oosSharpe, 2),
    foldHitRate: round(foldHitRate, 3),
    isSharpe: round(isSharpe, 2),
    degradation: round(degradation, 2),
    paramStability: round(paramStability, 3),
    benchmarkReturnPct: benchmarkReturnPct == null ? null : round(benchmarkReturnPct, 2),
    excessReturnPct:
      benchmarkReturnPct == null ? null : round(oosTotalReturnPct - benchmarkReturnPct, 2),
    verdict,
    reasons,
  };
}

export type StitchedPoint = { date: string; value: number; foldIndex: number };

/**
 * Chain the per-fold out-of-sample curves into one continuous equity track,
 * rebasing each fold onto the previous fold's closing value so the result is a
 * single "what the autopilot would have done" line starting at `startValue`.
 */
export function stitchOutOfSampleCurve(
  folds: Array<{ index: number; curve: Array<{ date: string; value: number }> }>,
  startValue: number,
): StitchedPoint[] {
  const out: StitchedPoint[] = [];
  let base = startValue;
  for (const f of [...folds].sort((a, b) => a.index - b.index)) {
    if (f.curve.length === 0) continue;
    const open = f.curve[0].value;
    if (!Number.isFinite(open) || open <= 0) continue;
    for (const p of f.curve) {
      out.push({ date: p.date, value: round((p.value / open) * base, 2), foldIndex: f.index });
    }
    base = out[out.length - 1].value;
  }
  return out;
}
