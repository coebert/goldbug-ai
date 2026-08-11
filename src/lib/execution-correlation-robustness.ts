// How much of the fitted coupling is the market, and how much is the estimator?
//
// `execution-correlation-calibration.ts` returns four numbers — ρ_within and
// ρ_across, calm and stress — conditional on three arbitrary choices: the
// rolling window length, what gets correlated (returns vs absolute returns),
// and the correlation estimator itself (Pearson is not robust; two crash bars
// can carry a whole window). This module varies all three deliberately and
// resamples the tape, so the report says how far the fitted ρs move when the
// analyst's choices move.
//
// Three axes:
//
//   1. **Window length** — refit at 30 / 60 / 120 bars. A coupling estimate
//      that halves when the window doubles is a smoothing artefact, not a
//      parameter.
//   2. **Estimator** — Pearson, Spearman (rank → normal scores, so the number
//      stays on a correlation scale) and a winsorised Pearson that clips at
//      ±k sd. If Pearson sits far above the other two, the fit is being paid
//      for by a handful of bars.
//   3. **Sampling noise** — a moving-block bootstrap over the *bars*, resampled
//      jointly across symbols so the cross-section is preserved, refitting the
//      whole calibration on each resample. That gives an interval around every
//      leg and, more usefully, around the calm→stress separation.
//
// The separation is the number that matters. `contagion` is only a better
// description of the world than `blocks` if stress ρ is reliably above calm ρ;
// if the bootstrap interval on the separation straddles zero under any
// reasonable estimator choice, the honest structure is `blocks`.
//
// Everything is pure and seeded: same tape and same seed, same report.

import {
  calibrateCorrelations,
  returnSeries,
  type CalibrationBasis,
  type CalibrationOptions,
  type CorrelationCalibration,
} from "./execution-correlation-calibration";

// ------------------------------------------------------------------ plumbing

const mean = (xs: readonly number[]) => {
  const u = xs.filter((v) => Number.isFinite(v));
  return u.length ? u.reduce((a, b) => a + b, 0) / u.length : Number.NaN;
};

const sd = (xs: readonly number[]) => {
  const u = xs.filter((v) => Number.isFinite(v));
  if (u.length < 2) return 0;
  const m = mean(u);
  return Math.sqrt(u.reduce((a, b) => a + (b - m) ** 2, 0) / (u.length - 1));
};

const quantile = (sorted: readonly number[], q: number) => {
  if (!sorted.length) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

/** Seeded RNG so a robustness report reproduces run to run. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------- estimators

export type CorrelationEstimator = "pearson" | "spearman" | "winsorized";

export const ALL_ESTIMATORS: readonly CorrelationEstimator[] = [
  "pearson",
  "spearman",
  "winsorized",
];

/** Inverse standard normal CDF (Acklam), used for rank → normal scores. */
function probit(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
      / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
    / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Average ranks (ties shared), 1…n over the finite entries. */
function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).filter((e) => Number.isFinite(e.v));
  idx.sort((p, q) => p.v - q.v);
  const out = xs.map(() => Number.NaN);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]!.i] = r;
    i = j + 1;
  }
  return out;
}

/**
 * Rewrites one symbol's series so that a plain Pearson correlation of the
 * result equals the requested estimator's correlation of the original.
 *
 *  - `pearson`     — unchanged.
 *  - `spearman`    — rank, then map to normal scores (van der Waerden); the
 *                    Pearson correlation of normal scores is the rank
 *                    correlation, on a scale the structures can consume.
 *  - `winsorized`  — clip at ±k standard deviations, so a crash bar counts once
 *                    rather than dominating the window.
 */
export function transformForEstimator(
  values: readonly number[],
  estimator: CorrelationEstimator,
  winsorSd = 3,
): number[] {
  if (estimator === "pearson") return values.slice();
  if (estimator === "winsorized") {
    const m = mean(values);
    const s = sd(values);
    if (!(s > 0)) return values.slice();
    const lo = m - winsorSd * s;
    const hi = m + winsorSd * s;
    return values.map((v) =>
      Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : v);
  }
  // spearman
  const r = ranks(values);
  const n = r.filter((v) => Number.isFinite(v)).length;
  if (n < 3) return values.slice();
  return r.map((v) => (Number.isFinite(v) ? probit(v / (n + 1)) : v));
}

/**
 * Packs a per-symbol *return* matrix back into synthetic close series, so the
 * existing calibration path (which differences closes) sees exactly these
 * values. Prices are strictly positive by construction.
 */
export function closesFromReturns(
  retsBySymbol: ReadonlyMap<string, readonly number[]>,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [sym, rets] of retsBySymbol) {
    const closes = [1];
    let acc = 0;
    for (const r of rets) {
      acc += Number.isFinite(r) ? r : 0;
      closes.push(Math.exp(acc));
    }
    out.set(sym, closes);
  }
  return out;
}

// -------------------------------------------------------------------- shapes

export type Interval = {
  mean: number;
  sd: number;
  lo: number;
  hi: number;
};

export type RobustnessLegs = {
  calmWithin: number;
  calmAcross: number;
  stressWithin: number;
  stressAcross: number;
  /** stress − calm, the number that decides contagion vs blocks. */
  separationWithin: number;
  separationAcross: number;
};

export type RobustnessCell = RobustnessLegs & {
  window: number;
  estimator: CorrelationEstimator;
  basis: CalibrationBasis;
  /** Rolling windows the fit had to work with, and how many were stressed. */
  windowsFitted: number;
  stressWindows: number;
  stressShare: number;
  /** Bootstrap intervals for this cell, when resampling was requested. */
  bootstrap?: {
    resamples: number;
    blockBars: number;
    calmWithin: Interval;
    calmAcross: Interval;
    stressWithin: Interval;
    stressAcross: Interval;
    separationWithin: Interval;
    separationAcross: Interval;
    /** Share of resamples where stress ρ_within exceeded calm ρ_within. */
    separationPositiveShare: number;
  };
};

export type AxisSpread = {
  axis: "window" | "estimator";
  /** The level held fixed, e.g. `60` or `"spearman"`. */
  level: string;
  cells: number;
  calmWithin: { mean: number; min: number; max: number; range: number };
  stressWithin: { mean: number; min: number; max: number; range: number };
  separationWithin: { mean: number; min: number; max: number; range: number };
};

export type CalibrationRobustness = {
  baseline: RobustnessCell;
  cells: RobustnessCell[];
  byWindow: AxisSpread[];
  byEstimator: AxisSpread[];
  /** Widest spread of each leg over the whole grid. */
  gridRange: {
    calmWithin: number;
    calmAcross: number;
    stressWithin: number;
    stressAcross: number;
    separationWithin: number;
  };
  verdict: "stable" | "window_sensitive" | "estimator_sensitive" | "fragile";
  notes: string[];
};

export type RobustnessOptions = Omit<CalibrationOptions, "window"> & {
  /** Window lengths to refit at. Default 30 / 60 / 120. */
  windows?: readonly number[];
  /** Estimators to compare. Default all three. */
  estimators?: readonly CorrelationEstimator[];
  /** Bootstrap resamples per cell. 0 disables (grid only). Default 200. */
  resamples?: number;
  /** Moving-block length in bars. Defaults to the fit window. */
  blockBars?: number;
  /** Bootstrap only the baseline cell instead of all of them. Default true. */
  bootstrapBaselineOnly?: boolean;
  /** Window length treated as the baseline. Default 60 (or the first given). */
  baselineWindow?: number;
  /** Estimator treated as the baseline. Default `pearson`. */
  baselineEstimator?: CorrelationEstimator;
  /** Clip level for the winsorised estimator, in sd. Default 3. */
  winsorSd?: number;
  seed?: number;
};

const DEFAULT_WINDOWS = [30, 60, 120] as const;

// ----------------------------------------------------------------- one fit

const legsOf = (cal: CorrelationCalibration): RobustnessLegs => {
  const calmWithin = cal.calm.within.rho;
  const calmAcross = cal.calm.across.rho;
  const stressWithin = cal.stress.within.rho;
  const stressAcross = cal.stress.across.rho;
  return {
    calmWithin,
    calmAcross,
    stressWithin,
    stressAcross,
    separationWithin: stressWithin - calmWithin,
    separationAcross: stressAcross - calmAcross,
  };
};

/**
 * One calibration on an already-transformed return matrix. `volZ` is passed
 * through untouched, so a resampled matrix must arrive with a resampled volZ.
 */
function fitOnReturns(
  retsBySymbol: ReadonlyMap<string, readonly number[]>,
  opts: CalibrationOptions,
): CorrelationCalibration {
  // The estimator transform already produced the basis quantity, so the
  // calibration must not take absolute values a second time.
  return calibrateCorrelations(closesFromReturns(retsBySymbol), {
    ...opts,
    basis: "returns",
  });
}

/** Returns for every symbol on the chosen basis, then estimator-transformed. */
function preparedReturns(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  basis: CalibrationBasis,
  estimator: CorrelationEstimator,
  winsorSd: number,
): Map<string, number[]> {
  const raw = returnSeries(seriesBySymbol, basis);
  const n = raw.size ? Math.min(...[...raw.values()].map((r) => r.length)) : 0;
  const out = new Map<string, number[]>();
  for (const [sym, rets] of raw) {
    out.set(sym, transformForEstimator(rets.slice(0, n), estimator, winsorSd));
  }
  return out;
}

// --------------------------------------------------------------- bootstrap

/**
 * Moving-block bootstrap over bars. Blocks of consecutive return indices are
 * drawn with replacement and applied to *every* symbol at once, so the
 * cross-sectional structure inside a block survives; only the ordering of
 * episodes is resampled. `volZ` follows the same index path, which keeps the
 * calm/stress labelling attached to the bars it belongs to.
 */
export function blockResampleIndices(
  n: number,
  blockBars: number,
  rand: () => number,
): number[] {
  const block = Math.max(1, Math.min(n, Math.floor(blockBars)));
  const idx: number[] = [];
  while (idx.length < n) {
    const start = Math.floor(rand() * Math.max(1, n - block + 1));
    for (let k = 0; k < block && idx.length < n; k++) idx.push(start + k);
  }
  return idx;
}

const interval = (xs: readonly number[]): Interval => {
  const u = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    mean: mean(u),
    sd: sd(u),
    lo: quantile(u, 0.025),
    hi: quantile(u, 0.975),
  };
};

// -------------------------------------------------------------------- report

/**
 * Refits the coupling across the window × estimator grid and bootstraps the
 * tape, then summarises how far the calm and stress ρs move. This is the
 * "should I believe these four numbers" report; `diagnoseCalibrationFit`
 * answers the complementary "does the structure fit the matrix" question.
 */
export function stressTestCalibration(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  opts: RobustnessOptions = {},
): CalibrationRobustness {
  const windows = (opts.windows?.length ? [...opts.windows] : [...DEFAULT_WINDOWS])
    .map((w) => Math.max(5, Math.floor(w)))
    .filter((w, i, a) => a.indexOf(w) === i)
    .sort((a, b) => a - b);
  const estimators = opts.estimators?.length ? [...opts.estimators] : [...ALL_ESTIMATORS];
  const basis = opts.basis ?? "absReturns";
  const winsorSd = opts.winsorSd ?? 3;
  const resamples = Math.max(0, Math.floor(opts.resamples ?? 200));
  const baselineOnly = opts.bootstrapBaselineOnly ?? true;
  const baseWindow = windows.includes(opts.baselineWindow ?? 60)
    ? (opts.baselineWindow ?? 60)
    : windows[Math.floor(windows.length / 2)]!;
  const baseEstimator = estimators.includes(opts.baselineEstimator ?? "pearson")
    ? (opts.baselineEstimator ?? "pearson")
    : estimators[0]!;
  const seed = opts.seed ?? 12345;
  const volZ = opts.volZ ?? [];

  const cells: RobustnessCell[] = [];

  for (const estimator of estimators) {
    const rets = preparedReturns(seriesBySymbol, basis, estimator, winsorSd);
    const barCount = rets.size ? Math.min(...[...rets.values()].map((r) => r.length)) : 0;

    for (const window of windows) {
      const cellOpts: CalibrationOptions = { ...opts, window, volZ, basis: "returns" };
      const cal = fitOnReturns(rets, cellOpts);
      const stressWindows = cal.windows.filter((w) => w.stressed).length;
      const cell: RobustnessCell = {
        window,
        estimator,
        basis,
        ...legsOf(cal),
        windowsFitted: cal.windows.length,
        stressWindows,
        stressShare: cal.stressShare,
      };

      const wantBoot = resamples > 0
        && (!baselineOnly || (window === baseWindow && estimator === baseEstimator));
      if (wantBoot && barCount > 10) {
        const blockBars = Math.max(2, Math.floor(opts.blockBars ?? window));
        const rand = mulberry32(seed + window * 7919 + estimators.indexOf(estimator) * 104729);
        const draws: RobustnessLegs[] = [];
        for (let b = 0; b < resamples; b++) {
          const idx = blockResampleIndices(barCount, blockBars, rand);
          const resampled = new Map<string, number[]>();
          for (const [sym, r] of rets) resampled.set(sym, idx.map((i) => r[i]!));
          // volZ is indexed by close, returns are offset by one bar.
          const zs = [volZ[0] ?? 0, ...idx.map((i) => volZ[i + 1] ?? 0)];
          draws.push(legsOf(fitOnReturns(resampled, { ...cellOpts, volZ: zs })));
        }
        cell.bootstrap = {
          resamples,
          blockBars,
          calmWithin: interval(draws.map((d) => d.calmWithin)),
          calmAcross: interval(draws.map((d) => d.calmAcross)),
          stressWithin: interval(draws.map((d) => d.stressWithin)),
          stressAcross: interval(draws.map((d) => d.stressAcross)),
          separationWithin: interval(draws.map((d) => d.separationWithin)),
          separationAcross: interval(draws.map((d) => d.separationAcross)),
          separationPositiveShare: (() => {
            const u = draws.map((d) => d.separationWithin).filter((v) => Number.isFinite(v));
            return u.length ? u.filter((v) => v > 0).length / u.length : Number.NaN;
          })(),
        };
      }

      cells.push(cell);
    }
  }

  const spread = (xs: readonly number[]) => {
    const u = xs.filter((v) => Number.isFinite(v));
    const min = u.length ? Math.min(...u) : Number.NaN;
    const max = u.length ? Math.max(...u) : Number.NaN;
    return { mean: mean(u), min, max, range: u.length ? max - min : Number.NaN };
  };

  const axis = (
    kind: "window" | "estimator",
    level: string,
    group: readonly RobustnessCell[],
  ): AxisSpread => ({
    axis: kind,
    level,
    cells: group.length,
    calmWithin: spread(group.map((c) => c.calmWithin)),
    stressWithin: spread(group.map((c) => c.stressWithin)),
    separationWithin: spread(group.map((c) => c.separationWithin)),
  });

  const byWindow = windows.map((w) =>
    axis("window", String(w), cells.filter((c) => c.window === w)));
  const byEstimator = estimators.map((e) =>
    axis("estimator", e, cells.filter((c) => c.estimator === e)));

  const gridRange = {
    calmWithin: spread(cells.map((c) => c.calmWithin)).range,
    calmAcross: spread(cells.map((c) => c.calmAcross)).range,
    stressWithin: spread(cells.map((c) => c.stressWithin)).range,
    stressAcross: spread(cells.map((c) => c.stressAcross)).range,
    separationWithin: spread(cells.map((c) => c.separationWithin)).range,
  };

  // Spread *caused by* each axis: how far the leg moves when only that axis
  // changes, averaged over the other one.
  // Judge the worst-behaved leg, not the calmest one: a calm ρ that holds
  // while the stress ρ swings by a third is not a stable calibration.
  const worst = (ranges: readonly { calmWithin: AxisSpread["calmWithin"]; stressWithin: AxisSpread["calmWithin"]; separationWithin: AxisSpread["calmWithin"] }[]) =>
    mean(ranges.map((a) => Math.max(
      a.calmWithin.range,
      Number.isFinite(a.stressWithin.range) ? a.stressWithin.range : 0,
      Number.isFinite(a.separationWithin.range) ? a.separationWithin.range : 0,
    )));
  const windowEffect = worst(byEstimator);
  const estimatorEffect = worst(byWindow);
  const LOOSE = 0.1;
  const windowSensitive = windowEffect > LOOSE;
  const estimatorSensitive = estimatorEffect > LOOSE;
  const verdict: CalibrationRobustness["verdict"] =
    windowSensitive && estimatorSensitive ? "fragile"
      : windowSensitive ? "window_sensitive"
        : estimatorSensitive ? "estimator_sensitive"
          : "stable";


  const baseline = cells.find((c) => c.window === baseWindow && c.estimator === baseEstimator)
    ?? cells[0]!;

  const notes: string[] = [];
  if (windowSensitive) {
    notes.push(
      `Window length moves the fitted ρs by up to ${windowEffect.toFixed(3)} on average — `
      + "the level is partly a smoothing choice, so pin the window in the snapshot.",
    );
  }
  if (estimatorSensitive) {
    const pearson = byEstimator.find((a) => a.level === "pearson")?.calmWithin.mean ?? NaN;
    const spearman = byEstimator.find((a) => a.level === "spearman")?.calmWithin.mean ?? NaN;
    notes.push(
      Number.isFinite(pearson) && Number.isFinite(spearman) && pearson > spearman + 0.05
        ? `Pearson (${pearson.toFixed(3)}) sits above Spearman (${spearman.toFixed(3)}): `
          + "outlier bars are paying for the coupling — prefer the winsorised or rank fit."
        : `Estimator choice moves the fitted ρs by up to ${estimatorEffect.toFixed(3)}.`,
    );
  }
  const boot = baseline.bootstrap;
  if (boot) {
    const sep = boot.separationWithin;
    notes.push(
      sep.lo > 0
        ? `Calm→stress separation is positive across the bootstrap `
          + `(${sep.lo.toFixed(3)}…${sep.hi.toFixed(3)}, ${(boot.separationPositiveShare * 100).toFixed(0)}% of resamples): contagion is in the data.`
        : `Bootstrap separation interval straddles zero `
          + `(${sep.lo.toFixed(3)}…${sep.hi.toFixed(3)}): blocks is the honest structure.`,
    );
  }
  const thinStress = cells.filter((c) => c.stressWindows > 0 && c.stressWindows < 5);
  if (thinStress.length) {
    notes.push(
      `${thinStress.length}/${cells.length} cells fit the stress leg on fewer than 5 windows — `
      + "those stress ρs are anecdotes, not estimates.",
    );
  }
  if (!notes.length) notes.push("Fitted ρs hold their level across every window and estimator tried.");

  return { baseline, cells, byWindow, byEstimator, gridRange, verdict, notes };
}

// -------------------------------------------------------------------- format

const n3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : "  n/a");
const pad = (s: string, w: number) => s.padStart(w);

/** Console table for the report. */
export function formatCalibrationRobustness(r: CalibrationRobustness): string {
  const lines: string[] = [];
  lines.push("Calibration stress test — window × estimator grid (basis "
    + `${r.baseline.basis})`);
  lines.push("");
  lines.push([
    pad("estimator", 11), pad("win", 5), pad("calmW", 8), pad("calmA", 8),
    pad("strW", 8), pad("strA", 8), pad("sepW", 8), pad("wins", 6), pad("str%", 7),
  ].join(" "));
  for (const c of r.cells) {
    lines.push([
      pad(c.estimator, 11), pad(String(c.window), 5),
      pad(n3(c.calmWithin), 8), pad(n3(c.calmAcross), 8),
      pad(n3(c.stressWithin), 8), pad(n3(c.stressAcross), 8),
      pad(n3(c.separationWithin), 8),
      pad(String(c.windowsFitted), 6),
      pad((c.stressShare * 100).toFixed(1), 7),
    ].join(" "));
  }

  lines.push("");
  lines.push("Spread by axis (calm ρ_within / stress ρ_within / separation)");
  for (const a of [...r.byWindow, ...r.byEstimator]) {
    lines.push(
      `  ${a.axis === "window" ? "window " : "estimator "}${pad(a.level, 9)}  `
      + `calm ${n3(a.calmWithin.mean)} [${n3(a.calmWithin.min)}…${n3(a.calmWithin.max)}]  `
      + `stress ${n3(a.stressWithin.mean)} [${n3(a.stressWithin.min)}…${n3(a.stressWithin.max)}]  `
      + `sep ${n3(a.separationWithin.mean)} (range ${n3(a.separationWithin.range)})`,
    );
  }

  const b = r.baseline.bootstrap;
  if (b) {
    lines.push("");
    lines.push(
      `Moving-block bootstrap on the baseline cell `
      + `(${r.baseline.estimator}, window ${r.baseline.window}, `
      + `${b.resamples} resamples, ${b.blockBars}-bar blocks)`,
    );
    const row = (label: string, i: Interval) =>
      `  ${pad(label, 18)}  ${n3(i.mean)}  95% CI [${n3(i.lo)} … ${n3(i.hi)}]  sd ${n3(i.sd)}`;
    lines.push(row("calm within", b.calmWithin));
    lines.push(row("calm across", b.calmAcross));
    lines.push(row("stress within", b.stressWithin));
    lines.push(row("stress across", b.stressAcross));
    lines.push(row("separation within", b.separationWithin));
    lines.push(row("separation across", b.separationAcross));
  }

  lines.push("");
  lines.push(`Grid range: calmW ${n3(r.gridRange.calmWithin)}  calmA ${n3(r.gridRange.calmAcross)}  `
    + `strW ${n3(r.gridRange.stressWithin)}  strA ${n3(r.gridRange.stressAcross)}  `
    + `sepW ${n3(r.gridRange.separationWithin)}`);
  lines.push(`Verdict: ${r.verdict}`);
  for (const note of r.notes) lines.push(`  - ${note}`);
  return lines.join("\n");
}
