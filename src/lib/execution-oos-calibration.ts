// Out-of-sample evaluation of calibrated correlation structures.
//
// A calibration always fits its own sample. The only question that matters for
// the simulator is whether coupling estimated on data the strategy has already
// seen still describes the coupling it is about to trade through. This module
// does the walk-forward version of that test:
//
//   for each fold: calibrate on TRAIN bars only → score the structure against
//   the cluster × cluster correlations measured on the untouched TEST bars.
//
// Fixed-parameter baselines (independent, a single global ρ, hand-set blocks or
// contagion) go through exactly the same scoring, so "calibration is worth it"
// becomes a number instead of an argument. The companion `--oos-corr` mode in
// scripts/run-execution-monte-carlo.ts then feeds these same per-fold
// structures into the shock simulator and reports the usual tail metrics on
// common random numbers, so the fit table and the P&L table describe one
// experiment.
//
// Nothing here is stochastic: given the same tape and folds it returns the same
// numbers every time.

import {
  calibrateCorrelations,
  structureFromCalibration,
  type CalibrationOptions,
  type CorrelationCalibration,
} from "./execution-correlation-calibration";
import { clusterSpilloverMatrix } from "./execution-cluster-spillover";
import { residualCorrelationErrors, type ResidualReport } from "./execution-correlation-diagnostics";
import type {
  CorrelationStructure,
  CorrelationStructureKind,
} from "./execution-correlation-structures";

/** One walk-forward fold, as bar indices into the tape. */
export type FoldWindow = {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
};

export type CalibratableKind = Extract<CorrelationStructureKind, "blocks" | "contagion">;

export type OosCalibrationOptions = CalibrationOptions & {
  /** Per-bar realised-vol z-scores for the whole tape; sliced per fold. */
  volZ?: readonly number[];
  /**
   * Stress ρ_within risk control. Each fold's stress lift is scaled by the
   * bootstrap credibility of that fold's own stress estimate, so a fold with a
   * thin stress bucket cannot hand the simulator a confident contagion number.
   * Pass `{ enabled: false }` to use the raw fitted stress ρ.
   */
  rhoGovernor?: StressRhoGovernorOptions;
};


/**
 * Bar-window slice of every symbol's series, inclusive of both ends.
 *
 * Correlation windows are computed on returns, so a slice starting at
 * `from` silently drops the return into `from`; that one bar is immaterial next
 * to a 500-bar train window and keeps the slice honest about not peeking at the
 * bar before the fold.
 */
export function sliceSeriesWindow(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  from: number,
  to: number,
): Map<string, number[]> {
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.floor(to);
  const out = new Map<string, number[]>();
  for (const [sym, series] of seriesBySymbol) {
    const cut = series.slice(lo, hi + 1);
    if (cut.length >= 3) out.set(sym, [...cut]);
  }
  return out;
}

const sliceVolZ = (volZ: readonly number[] | undefined, from: number, to: number) =>
  volZ ? volZ.slice(Math.max(0, Math.floor(from)), Math.floor(to) + 1) : undefined;

// ------------------------------------------------------- per-fold calibration

export type FoldCalibration = {
  fold: number;
  kind: CalibratableKind;
  /** Structure fitted on the fold's TRAIN bars only. */
  structure: CorrelationStructure;
  calibration: CorrelationCalibration;
  trainWindows: number;
  trainStressWindows: number;
  /** True when the train window contained no stressed windows to learn from. */
  stressStarved: boolean;
};

/**
 * Calibrates one structure per fold on train bars only.
 *
 * When a train window happens to contain no stressed windows, the underlying
 * `structureFromCalibration` falls back to the calm estimate rather than
 * inventing a stress regime — the fold is flagged `stressStarved` so the report
 * can say the contagion arm had nothing to learn from there.
 */
export function calibrateFoldStructures(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  folds: readonly FoldWindow[],
  kind: CalibratableKind,
  opts: OosCalibrationOptions = {},
): FoldCalibration[] {
  return folds.map((f, i) => {
    const train = sliceSeriesWindow(seriesBySymbol, f.trainStart, f.trainEnd);
    const calibration = calibrateCorrelations(train, {
      ...opts,
      volZ: sliceVolZ(opts.volZ, f.trainStart, f.trainEnd),
    });
    const stressWindows = calibration.windows.filter((w) => w.stressed).length;
    return {
      fold: i,
      kind,
      structure: structureFromCalibration(calibration, kind, opts.groups),
      calibration,
      trainWindows: calibration.windows.length,
      trainStressWindows: stressWindows,
      stressStarved: stressWindows === 0,
    };
  });
}

// ------------------------------------------------------------- fit scoring

export type FoldFit = {
  fold: number;
  /** Weighted residual RMSE against the fold's own TRAIN bars. */
  inSampleRmse: number;
  /** Weighted residual RMSE against the untouched TEST bars — the honest score. */
  outOfSampleRmse: number;
  /** outOfSample − inSample: how much the fit decays off-sample. */
  drift: number;
  /** Signed bias on TEST: positive = the structure over-couples the future. */
  outOfSampleBias: number;
  testResiduals: ResidualReport;
  testStressWindows: number;
};

/**
 * Scores one structure per fold against both halves of that fold.
 *
 * `structureFor` receives the fold index, so calibrated arms (a different
 * structure per fold) and fixed baselines (the same structure everywhere) are
 * scored by identical code on identical windows.
 */
export function evaluateFoldFit(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  folds: readonly FoldWindow[],
  structureFor: (foldIndex: number) => CorrelationStructure,
  opts: OosCalibrationOptions = {},
): FoldFit[] {
  return folds.map((f, i) => {
    const structure = structureFor(i);
    const trainSpill = clusterSpilloverMatrix(
      sliceSeriesWindow(seriesBySymbol, f.trainStart, f.trainEnd),
      { ...opts, volZ: sliceVolZ(opts.volZ, f.trainStart, f.trainEnd) },
    );
    const testSpill = clusterSpilloverMatrix(
      sliceSeriesWindow(seriesBySymbol, f.testStart, f.testEnd),
      { ...opts, volZ: sliceVolZ(opts.volZ, f.testStart, f.testEnd) },
    );
    const inSample = residualCorrelationErrors(structure, trainSpill, structure.kind);
    const outSample = residualCorrelationErrors(structure, testSpill, structure.kind);
    return {
      fold: i,
      inSampleRmse: inSample.weightedRmse,
      outOfSampleRmse: outSample.weightedRmse,
      drift: outSample.weightedRmse - inSample.weightedRmse,
      outOfSampleBias: outSample.bias,
      testResiduals: outSample,
      testStressWindows: testSpill.stressWindows,
    };
  });
}

// ---------------------------------------------------------------- summarising

export type FitSummary = {
  label: string;
  folds: number;
  meanInSample: number;
  meanOutOfSample: number;
  medianOutOfSample: number;
  worstOutOfSample: number;
  meanDrift: number;
  meanBias: number;
  /** Folds where the structure over-coupled the test window (bias > 0). */
  overCoupledFolds: number;
};

const finite = (xs: readonly number[]) => xs.filter((v) => Number.isFinite(v));
const mean = (xs: readonly number[]) =>
  finite(xs).length ? finite(xs).reduce((a, b) => a + b, 0) / finite(xs).length : Number.NaN;
const median = (xs: readonly number[]) => {
  const s = finite(xs).sort((a, b) => a - b);
  if (!s.length) return Number.NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function summariseFoldFits(label: string, fits: readonly FoldFit[]): FitSummary {
  const oos = fits.map((f) => f.outOfSampleRmse);
  return {
    label,
    folds: fits.length,
    meanInSample: mean(fits.map((f) => f.inSampleRmse)),
    meanOutOfSample: mean(oos),
    medianOutOfSample: median(oos),
    worstOutOfSample: finite(oos).length ? Math.max(...finite(oos)) : Number.NaN,
    meanDrift: mean(fits.map((f) => f.drift)),
    meanBias: mean(fits.map((f) => f.outOfSampleBias)),
    overCoupledFolds: fits.filter((f) => f.outOfSampleBias > 0).length,
  };
}

/**
 * Paired fold-by-fold comparison of two arms. Because both arms are scored on
 * the same folds and the same test windows, the win rate and the mean paired
 * difference are like-for-like: negative `meanDiff` means `arm` predicts the
 * future coupling better than `baseline`.
 */
export type PairedFitComparison = {
  arm: string;
  baseline: string;
  folds: number;
  /** mean(arm − baseline) out-of-sample RMSE; negative = arm is better. */
  meanDiff: number;
  /** Share of folds where the arm's out-of-sample RMSE is lower. */
  winRate: number;
  /** Mean relative improvement vs the baseline, as a fraction. */
  relImprovement: number;
};

export function compareFoldFits(
  armLabel: string,
  arm: readonly FoldFit[],
  baselineLabel: string,
  baseline: readonly FoldFit[],
): PairedFitComparison {
  const n = Math.min(arm.length, baseline.length);
  const diffs: number[] = [];
  const rels: number[] = [];
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const a = arm[i]!.outOfSampleRmse;
    const b = baseline[i]!.outOfSampleRmse;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    diffs.push(a - b);
    if (b > 0) rels.push((b - a) / b);
    if (a < b) wins++;
  }
  return {
    arm: armLabel,
    baseline: baselineLabel,
    folds: diffs.length,
    meanDiff: mean(diffs),
    winRate: diffs.length ? wins / diffs.length : Number.NaN,
    relImprovement: mean(rels),
  };
}

// ------------------------------------------------------------------ printing

const num = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");

/** Table of out-of-sample fit quality, one row per arm. */
export function formatFitSummaries(summaries: readonly FitSummary[]): string {
  const lines: string[] = [];
  const header = [
    "arm".padEnd(22), "folds".padStart(6), "IS rmse".padStart(9), "OOS rmse".padStart(9),
    "OOS med".padStart(9), "OOS worst".padStart(10), "drift".padStart(8),
    "bias".padStart(8), "over".padStart(6),
  ].join(" ");
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const s of summaries) {
    lines.push([
      s.label.padEnd(22), String(s.folds).padStart(6), num(s.meanInSample).padStart(9),
      num(s.meanOutOfSample).padStart(9), num(s.medianOutOfSample).padStart(9),
      num(s.worstOutOfSample).padStart(10),
      `${s.meanDrift >= 0 ? "+" : ""}${num(s.meanDrift)}`.padStart(8),
      `${s.meanBias >= 0 ? "+" : ""}${num(s.meanBias)}`.padStart(8),
      `${s.overCoupledFolds}/${s.folds}`.padStart(6),
    ].join(" "));
  }
  return lines.join("\n");
}

/** Paired win/loss table against one reference arm. */
export function formatFitComparisons(rows: readonly PairedFitComparison[]): string {
  const lines: string[] = [];
  const header = [
    "arm".padEnd(22), "vs".padEnd(22), "Δ rmse".padStart(9),
    "win rate".padStart(9), "rel. impr".padStart(10),
  ].join(" ");
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const r of rows) {
    lines.push([
      r.arm.padEnd(22), r.baseline.padEnd(22),
      `${r.meanDiff >= 0 ? "+" : ""}${num(r.meanDiff)}`.padStart(9),
      `${(r.winRate * 100).toFixed(0)}%`.padStart(9),
      `${(r.relImprovement * 100).toFixed(1)}%`.padStart(10),
    ].join(" "));
  }
  return lines.join("\n");
}
