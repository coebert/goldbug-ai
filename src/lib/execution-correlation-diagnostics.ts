// Calibration diagnostics: how much should you believe the fitted coupling?
//
// `execution-correlation-calibration.ts` returns point estimates (ρ_within,
// ρ_across, calm and stress) and a per-window standard deviation. That is not
// enough to act on. Three questions decide whether a calibrated structure is
// worth wiring into the simulator:
//
//   1. **Stability** — is the rolling fit a parameter or a wandering line?
//      Overlapping windows make the raw sd look reassuringly small, so we
//      report an effective sample size, lag-1 autocorrelation, a first-half /
//      second-half drift and the trend slope alongside it.
//   2. **Confidence** — a moving-block bootstrap over the *window series*
//      (block length = the overlap span, so resamples respect the induced
//      autocorrelation) gives honest intervals on ρ_within, ρ_across and on
//      the calm→stress separation. If the separation interval straddles zero,
//      "contagion" is not in the data and `blocks` is the honest structure.
//   3. **Residuals** — the structure is a two-number approximation of a whole
//      cluster × cluster matrix. `residualCorrelationErrors` scores implied
//      minus realised for every cluster pair, in both regimes, so you can see
//      which pairs the approximation misprices and by how much.
//
// Everything is pure and derived from the same rolling windows the
// calibration itself uses, so the diagnostics describe the fit you shipped.

import {
  calibrateCorrelations,
  fisherMean,
  rollingCorrelationWindows,
  structureFromCalibration,
  type CalibrationOptions,
  type CorrelationCalibration,
  type RollingCorrelationWindow,
} from "./execution-correlation-calibration";
import {
  clusterSpilloverMatrix,
  type ClusterSpillover,
} from "./execution-cluster-spillover";
import {
  regimeRhos,
  type CorrelationStructure,
  type CorrelationStructureKind,
} from "./execution-correlation-structures";

// ------------------------------------------------------------------ plumbing

const atanh = (r: number) => {
  const x = Math.min(0.999999, Math.max(-0.999999, r));
  return 0.5 * Math.log((1 + x) / (1 - x));
};
const tanh = Math.tanh;

const finite = (xs: readonly number[]) => xs.filter((v) => Number.isFinite(v));

const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;

const sd = (xs: readonly number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

const quantile = (sorted: readonly number[], q: number) => {
  if (!sorted.length) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

/** Seeded RNG so a diagnostics report is reproducible run to run. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------- stability

export type RollingStability = {
  /** Windows contributing to the series. */
  n: number;
  /**
   * Effective sample size after discounting overlap: rolling windows share
   * bars, so `n` badly overstates the information content.
   */
  effN: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  iqr: number;
  /** Lag-1 autocorrelation of the rolling estimate; ~1 means one slow trend. */
  autocorr1: number;
  /** Mean of the first half of the sample. */
  firstHalf: number;
  /** Mean of the second half. */
  secondHalf: number;
  /** secondHalf − firstHalf: sign and size of the drift. */
  drift: number;
  /** OLS slope per window of the rolling estimate. */
  slopePerWindow: number;
  /** sd / |mean| — a scale-free instability score (lower is steadier). */
  coefVar: number;
};

/**
 * Stability profile of one rolling correlation series.
 *
 * `overlapRatio` = window / step is how many consecutive estimates share bars;
 * the effective sample size divides by it, which is the difference between
 * "185 windows" and "about 15 independent looks at the tape".
 */
export function rollingStability(
  values: readonly number[],
  overlapRatio = 1,
): RollingStability {
  const xs = finite(values);
  const n = xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = mean(xs);
  const s = sd(xs);
  const half = Math.floor(n / 2);
  const first = mean(xs.slice(0, half));
  const second = mean(xs.slice(n - half));

  let auto = Number.NaN;
  if (n > 2 && s > 0) {
    let num = 0;
    for (let i = 1; i < n; i++) num += (xs[i]! - m) * (xs[i - 1]! - m);
    const den = xs.reduce((a, b) => a + (b - m) ** 2, 0);
    auto = den > 0 ? num / den : Number.NaN;
  }

  let slope = Number.NaN;
  if (n > 1) {
    const xm = (n - 1) / 2;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xm) * (xs[i]! - m);
      den += (i - xm) ** 2;
    }
    slope = den > 0 ? num / den : Number.NaN;
  }

  return {
    n,
    effN: Math.max(1, n / Math.max(1, overlapRatio)),
    mean: m,
    sd: s,
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
    iqr: quantile(sorted, 0.75) - quantile(sorted, 0.25),
    autocorr1: auto,
    firstHalf: first,
    secondHalf: second,
    drift: second - first,
    slopePerWindow: slope,
    coefVar: Math.abs(m) > 1e-9 ? s / Math.abs(m) : Number.NaN,
  };
}

// ---------------------------------------------------------------- confidence

export type ConfidenceInterval = {
  /** Point estimate (Fisher-z pooled). */
  estimate: number;
  lo: number;
  hi: number;
  /** Standard error in Fisher-z space. */
  seZ: number;
  level: number;
  /** Bootstrap resamples that produced a usable estimate. */
  resamples: number;
  /** Effective (overlap-discounted) sample size behind the estimate. */
  effN: number;
};

export type BootstrapOptions = {
  /** Confidence level, default 0.95. */
  level?: number;
  /** Bootstrap resamples, default 800. */
  resamples?: number;
  /** Moving-block length in windows; defaults to the overlap span. */
  blockSize?: number;
  seed?: number;
};

const EMPTY_CI = (level: number): ConfidenceInterval => ({
  estimate: Number.NaN, lo: Number.NaN, hi: Number.NaN,
  seZ: Number.NaN, level, resamples: 0, effN: 0,
});

/**
 * Moving-block bootstrap CI for a pooled correlation.
 *
 * Blocks (not individual windows) are resampled because consecutive rolling
 * windows overlap: an i.i.d. bootstrap would treat the same bars as
 * independent evidence and report an interval that is far too tight.
 */
export function bootstrapRhoCI(
  values: readonly number[],
  opts: BootstrapOptions = {},
): ConfidenceInterval {
  const level = opts.level ?? 0.95;
  const xs = finite(values);
  if (xs.length < 2) {
    const only = xs.length === 1
      ? { ...EMPTY_CI(level), estimate: xs[0]!, lo: xs[0]!, hi: xs[0]!, effN: 1 }
      : EMPTY_CI(level);
    return only;
  }
  const resamples = Math.max(50, Math.floor(opts.resamples ?? 800));
  const block = Math.max(1, Math.min(xs.length, Math.floor(opts.blockSize ?? 1)));
  const rng = mulberry32(opts.seed ?? 0x5eed);
  const blocks = Math.ceil(xs.length / block);
  const draws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    const sample: number[] = [];
    for (let k = 0; k < blocks; k++) {
      const start = Math.floor(rng() * Math.max(1, xs.length - block + 1));
      for (let i = 0; i < block && sample.length < xs.length; i++) sample.push(xs[start + i]!);
    }
    const r = fisherMean(sample);
    if (Number.isFinite(r)) draws.push(r);
  }
  draws.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const zs = finite(xs.map(atanh));
  const effN = Math.max(1, xs.length / block);
  return {
    estimate: fisherMean(xs),
    lo: quantile(draws, alpha),
    hi: quantile(draws, 1 - alpha),
    seZ: sd(zs) / Math.sqrt(effN),
    level,
    resamples: draws.length,
    effN,
  };
}

/**
 * Bootstrap CI for the calm→stress separation (stress ρ − calm ρ). Calm and
 * stress windows are resampled independently, which is the right null: it asks
 * whether the two buckets could have come from the same coupling.
 */
export function bootstrapSeparationCI(
  calm: readonly number[],
  stress: readonly number[],
  opts: BootstrapOptions = {},
): ConfidenceInterval {
  const level = opts.level ?? 0.95;
  const c = finite(calm);
  const s = finite(stress);
  if (c.length < 2 || s.length < 2) return EMPTY_CI(level);
  const resamples = Math.max(50, Math.floor(opts.resamples ?? 800));
  const block = Math.max(1, Math.floor(opts.blockSize ?? 1));
  const rng = mulberry32((opts.seed ?? 0x5eed) ^ 0x1234567);
  const resample = (xs: readonly number[]) => {
    const b = Math.min(block, xs.length);
    const out: number[] = [];
    while (out.length < xs.length) {
      const start = Math.floor(rng() * Math.max(1, xs.length - b + 1));
      for (let i = 0; i < b && out.length < xs.length; i++) out.push(xs[start + i]!);
    }
    return fisherMean(out);
  };
  const draws: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const d = resample(s) - resample(c);
    if (Number.isFinite(d)) draws.push(d);
  }
  draws.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return {
    estimate: fisherMean(s) - fisherMean(c),
    lo: quantile(draws, alpha),
    hi: quantile(draws, 1 - alpha),
    seZ: sd(draws),
    level,
    resamples: draws.length,
    effN: Math.max(1, Math.min(c.length, s.length) / Math.max(1, block)),
  };
}

// ----------------------------------------------------------------- residuals

export type PairResidual = {
  a: string;
  b: string;
  regime: "calm" | "stress";
  /** Correlation the fitted structure implies for this cluster pair. */
  implied: number;
  /** Correlation measured on the tape for this cluster pair. */
  realised: number;
  /** implied − realised. Positive = the structure overstates the coupling. */
  error: number;
  /** Symbol pairs behind the realised estimate (its weight). */
  pairs: number;
};

export type ResidualReport = {
  kind: CorrelationStructureKind;
  residuals: PairResidual[];
  /** Root-mean-square error over all observed cluster pairs. */
  rmse: number;
  /** Pair-count-weighted RMSE — the error that actually matters for a portfolio. */
  weightedRmse: number;
  /** Mean signed error: positive means the structure is systematically too coupled. */
  bias: number;
  rmseCalm: number;
  rmseStress: number;
  /** Worst single cluster pair by |error|. */
  worst: PairResidual | null;
};

/**
 * Scores a fitted structure against the measured cluster × cluster matrix.
 *
 * The structure only knows "within" and "across"; the tape knows every pair.
 * These residuals are the price of that compression — a large positive error
 * on one pair means the simulator is shocking two clusters together far harder
 * than history ever did.
 */
export function residualCorrelationErrors(
  structure: CorrelationStructure,
  spillover: ClusterSpillover,
  kind: CorrelationStructureKind = "blocks",
): ResidualReport {
  const calmRhos = regimeRhos(structure, 0);
  const stressRhos = regimeRhos(structure, 1);
  const residuals: PairResidual[] = [];

  for (let i = 0; i < spillover.clusters.length; i++) {
    for (let j = i; j < spillover.clusters.length; j++) {
      const cell = spillover.cells[i]![j]!;
      const same = i === j;
      for (const regime of ["calm", "stress"] as const) {
        const realised = regime === "calm" ? cell.calm : cell.stress;
        if (!Number.isFinite(realised)) continue;
        const rhos = regime === "calm" ? calmRhos : stressRhos;
        const implied = same ? rhos.withinRho : rhos.acrossRho;
        residuals.push({
          a: spillover.clusters[i]!,
          b: spillover.clusters[j]!,
          regime,
          implied,
          realised,
          error: implied - realised,
          pairs: cell.pairs,
        });
      }
    }
  }

  const errs = residuals.map((r) => r.error);
  const rms = (rs: readonly PairResidual[]) =>
    rs.length ? Math.sqrt(rs.reduce((a, r) => a + r.error ** 2, 0) / rs.length) : Number.NaN;
  const wSum = residuals.reduce((a, r) => a + Math.max(1, r.pairs), 0);
  const weightedRmse = residuals.length
    ? Math.sqrt(residuals.reduce((a, r) => a + Math.max(1, r.pairs) * r.error ** 2, 0) / wSum)
    : Number.NaN;

  const worst = residuals.length
    ? residuals.reduce((w, r) => (Math.abs(r.error) > Math.abs(w.error) ? r : w))
    : null;

  return {
    kind,
    residuals,
    rmse: rms(residuals),
    weightedRmse,
    bias: mean(errs),
    rmseCalm: rms(residuals.filter((r) => r.regime === "calm")),
    rmseStress: rms(residuals.filter((r) => r.regime === "stress")),
    worst,
  };
}

// ------------------------------------------------------------- full report

export type StructureDiagnostics = {
  kind: CorrelationStructureKind;
  structure: CorrelationStructure;
  residuals: ResidualReport;
};

export type CalibrationDiagnostics = {
  calibration: CorrelationCalibration;
  spillover: ClusterSpillover;
  /** Windows per independent look at the tape (window / step). */
  overlapRatio: number;
  stability: {
    within: RollingStability;
    across: RollingStability;
    calmWithin: RollingStability;
    stressWithin: RollingStability;
  };
  confidence: {
    calmWithin: ConfidenceInterval;
    calmAcross: ConfidenceInterval;
    stressWithin: ConfidenceInterval;
    stressAcross: ConfidenceInterval;
    /** stress − calm on the within-cluster leg. */
    withinSeparation: ConfidenceInterval;
    /** stress − calm on the across-cluster leg — the contagion test. */
    acrossSeparation: ConfidenceInterval;
  };
  /** True when the across-cluster separation interval excludes zero. */
  contagionSupported: boolean;
  structures: StructureDiagnostics[];
  /** Structure with the lowest weighted residual RMSE. */
  bestFit: CorrelationStructureKind | null;
};

export type DiagnosticsOptions = CalibrationOptions & BootstrapOptions & {
  /** Which structures to score; defaults to both. */
  kinds?: ReadonlyArray<Extract<CorrelationStructureKind, "blocks" | "contagion">>;
};

/**
 * Full diagnostics bundle for a calibrated coupling: stability of the rolling
 * fit, bootstrap intervals (including the contagion test), and per-cluster-pair
 * residuals for the `blocks` and `contagion` structures.
 */
export function diagnoseCalibrationFit(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  opts: DiagnosticsOptions = {},
): CalibrationDiagnostics {
  const window = Math.max(5, Math.floor(opts.window ?? 60));
  const step = Math.max(1, Math.floor(opts.step ?? 5));
  const overlapRatio = Math.max(1, window / step);
  const blockSize = Math.max(1, Math.round(opts.blockSize ?? overlapRatio));

  const calibration = calibrateCorrelations(seriesBySymbol, { ...opts, window, step });
  const spillover = clusterSpilloverMatrix(seriesBySymbol, { ...opts, window, step });
  const rows: RollingCorrelationWindow[] = calibration.windows.length
    ? calibration.windows
    : rollingCorrelationWindows(seriesBySymbol, { ...opts, window, step });

  const within = rows.map((r) => r.withinRho);
  const across = rows.map((r) => r.acrossRho);
  const calmRows = rows.filter((r) => !r.stressed);
  const stressRows = rows.filter((r) => r.stressed);

  const boot = { ...opts, blockSize };
  const confidence = {
    calmWithin: bootstrapRhoCI(calmRows.map((r) => r.withinRho), boot),
    calmAcross: bootstrapRhoCI(calmRows.map((r) => r.acrossRho), boot),
    stressWithin: bootstrapRhoCI(stressRows.map((r) => r.withinRho), boot),
    stressAcross: bootstrapRhoCI(stressRows.map((r) => r.acrossRho), boot),
    withinSeparation: bootstrapSeparationCI(
      calmRows.map((r) => r.withinRho), stressRows.map((r) => r.withinRho), boot,
    ),
    acrossSeparation: bootstrapSeparationCI(
      calmRows.map((r) => r.acrossRho), stressRows.map((r) => r.acrossRho), boot,
    ),
  };

  const kinds = opts.kinds ?? (["blocks", "contagion"] as const);
  const structures: StructureDiagnostics[] = kinds.map((kind) => {
    const structure = structureFromCalibration(calibration, kind, opts.groups);
    return { kind, structure, residuals: residualCorrelationErrors(structure, spillover, kind) };
  });

  const scored = structures.filter((s) => Number.isFinite(s.residuals.weightedRmse));
  const bestFit = scored.length
    ? scored.reduce((b, s) => (s.residuals.weightedRmse < b.residuals.weightedRmse ? s : b)).kind
    : null;

  const sep = confidence.acrossSeparation;
  const contagionSupported = Number.isFinite(sep.lo) && sep.lo > 0;

  return {
    calibration,
    spillover,
    overlapRatio,
    stability: {
      within: rollingStability(within, overlapRatio),
      across: rollingStability(across, overlapRatio),
      calmWithin: rollingStability(calmRows.map((r) => r.withinRho), overlapRatio),
      stressWithin: rollingStability(stressRows.map((r) => r.withinRho), overlapRatio),
    },
    confidence,
    contagionSupported,
    structures,
    bestFit,
  };
}

// ------------------------------------------------------------------ printing

const num = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const ci = (c: ConfidenceInterval) =>
  Number.isFinite(c.estimate)
    ? `${num(c.estimate)} [${num(c.lo)}, ${num(c.hi)}] (effN ${c.effN.toFixed(1)})`
    : "n/a";

/** Terminal report for the diagnostics bundle. */
export function formatCalibrationDiagnostics(d: CalibrationDiagnostics): string {
  const lines: string[] = [];
  const st = d.stability;

  lines.push("Rolling-fit stability (overlap-discounted)");
  lines.push([
    "series".padEnd(14), "n".padStart(5), "effN".padStart(6), "mean".padStart(7),
    "sd".padStart(7), "iqr".padStart(7), "ac1".padStart(7), "drift".padStart(7),
    "slope".padStart(9), "cv".padStart(6),
  ].join(" "));
  const row = (label: string, s: RollingStability) => lines.push([
    label.padEnd(14), String(s.n).padStart(5), s.effN.toFixed(1).padStart(6),
    num(s.mean).padStart(7), num(s.sd).padStart(7), num(s.iqr).padStart(7),
    num(s.autocorr1, 2).padStart(7), num(s.drift, 3).padStart(7),
    num(s.slopePerWindow, 5).padStart(9), num(s.coefVar, 2).padStart(6),
  ].join(" "));
  row("within (all)", st.within);
  row("across (all)", st.across);
  row("within calm", st.calmWithin);
  row("within stress", st.stressWithin);

  lines.push("");
  lines.push(`Bootstrap confidence (moving block, ${d.overlapRatio.toFixed(1)} windows/block)`);
  lines.push(`  calm   within ${ci(d.confidence.calmWithin)}`);
  lines.push(`  calm   across ${ci(d.confidence.calmAcross)}`);
  lines.push(`  stress within ${ci(d.confidence.stressWithin)}`);
  lines.push(`  stress across ${ci(d.confidence.stressAcross)}`);
  lines.push(`  separation within ${ci(d.confidence.withinSeparation)}`);
  lines.push(`  separation across ${ci(d.confidence.acrossSeparation)}`);
  lines.push(
    d.contagionSupported
      ? "  → contagion supported: the across-cluster separation interval excludes zero."
      : "  → contagion NOT established at this level: the across-cluster separation"
        + " interval includes zero, so `blocks` is the honest structure.",
  );

  for (const s of d.structures) {
    lines.push("");
    lines.push(
      `Residual correlation error — ${s.kind}: `
      + `rmse ${num(s.residuals.rmse)} (weighted ${num(s.residuals.weightedRmse)}), `
      + `bias ${num(s.residuals.bias)}, calm ${num(s.residuals.rmseCalm)}, `
      + `stress ${num(s.residuals.rmseStress)}`,
    );
    lines.push([
      "pair".padEnd(22), "regime".padEnd(7), "implied".padStart(8),
      "realised".padStart(9), "error".padStart(8), "pairs".padStart(6),
    ].join(" "));
    const worst = [...s.residuals.residuals]
      .sort((x, y) => Math.abs(y.error) - Math.abs(x.error))
      .slice(0, 8);
    for (const r of worst) {
      lines.push([
        `${r.a}↔${r.b}`.slice(0, 22).padEnd(22), r.regime.padEnd(7),
        num(r.implied).padStart(8), num(r.realised).padStart(9),
        `${r.error >= 0 ? "+" : ""}${num(r.error)}`.padStart(8),
        String(r.pairs).padStart(6),
      ].join(" "));
    }
  }

  if (d.bestFit) {
    lines.push("");
    lines.push(`Best weighted fit: ${d.bestFit}.`);
  }
  return lines.join("\n");
}
