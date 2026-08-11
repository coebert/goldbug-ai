// Calibrating the coupling assumption instead of guessing it.
//
// `execution-correlation-structures.ts` asks for four numbers: ρ_within and
// ρ_across in calm, and the same pair in stress. Until now those were typed in
// by hand. This module estimates them from the tape.
//
// Method, in one paragraph: take the price history, convert to returns, and
// slide a window over it. Inside each window compute every pairwise
// correlation, then pool same-cluster pairs and cross-cluster pairs separately
// using a Fisher-z average (averaging raw correlations is biased; averaging
// atanh and mapping back is not). Label each window calm or stressed by the
// share of its bars whose realised-volatility z-score breaches the stress
// trigger, and pool the two groups separately. The result is exactly the four
// numbers a `blocks` or `contagion` structure needs, plus the dispersion around
// them so you can see whether the estimate is worth anything.
//
// One honest caveat, stated loudly because it matters: the structures couple
// *log-slippage*, and this calibrates the correlation of *returns* (or absolute
// returns). Execution-cost histories per symbol are not available at this
// resolution, so we use co-movement as the proxy — names that move together
// widen together, because both are driven by the same liquidity withdrawal.
// Absolute returns are the default basis for that reason: slippage is a
// volatility phenomenon, not a directional one. `shrink` lets you deliberately
// pull the estimate toward zero if you think the proxy overstates the coupling.

import {
  makeCorrelationStructure,
  defaultCluster,
  type CorrelationStructure,
  type CorrelationStructureKind,
} from "./execution-correlation-structures";

export type CalibrationBasis = "returns" | "absReturns";

export type CalibrationOptions = {
  /** symbol → cluster label. Defaults to `defaultCluster` for every symbol. */
  groups?: ReadonlyMap<string, string>;
  /** Bars per rolling window. */
  window?: number;
  /** Bars between window starts. */
  step?: number;
  /** Per-bar realised-volatility z-score (see `marketVolZScores`). */
  volZ?: readonly number[];
  /** A bar counts as stressed at or above this z-score. */
  stressZ?: number;
  /** A window is stressed when at least this share of its bars are. */
  minStressShare?: number;
  /** What to correlate: raw returns, or absolute returns (a vol proxy). */
  basis?: CalibrationBasis;
  /** Multiply the estimated correlations by this before use, 0…1. */
  shrink?: number;
};

const DEFAULTS = {
  window: 60,
  step: 5,
  stressZ: 1.5,
  minStressShare: 0.25,
  basis: "absReturns" as CalibrationBasis,
  shrink: 1,
};

export type RollingCorrelationWindow = {
  /** Index of the last bar in the window. */
  endIndex: number;
  bars: number;
  /** Pooled correlation of same-cluster pairs (NaN when there are none). */
  withinRho: number;
  /** Pooled correlation of cross-cluster pairs (NaN when there are none). */
  acrossRho: number;
  withinPairs: number;
  acrossPairs: number;
  /** Share of the window's bars whose vol z-score breached `stressZ`. */
  stressShare: number;
  stressed: boolean;
};

export type PooledRho = {
  /** Fisher-z pooled correlation across the windows in this regime. */
  rho: number;
  /** Standard deviation of the per-window estimates (raw correlation space). */
  sd: number;
  /** Windows contributing to the estimate. */
  windows: number;
};

export type CorrelationCalibration = {
  basis: CalibrationBasis;
  window: number;
  step: number;
  shrink: number;
  symbols: string[];
  clusters: string[];
  /** Every rolling window, in order — the time series of the coupling. */
  windows: RollingCorrelationWindow[];
  calm: { within: PooledRho; across: PooledRho };
  stress: { within: PooledRho; across: PooledRho };
  /** Share of windows classified stressed. */
  stressShare: number;
};

// ------------------------------------------------------------------ plumbing

const atanh = (r: number) => {
  const x = Math.min(0.999999, Math.max(-0.999999, r));
  return 0.5 * Math.log((1 + x) / (1 - x));
};

/** Fisher-z mean of correlations; returns NaN when nothing is poolable. */
export function fisherMean(rhos: readonly number[]): number {
  const usable = rhos.filter((r) => Number.isFinite(r));
  if (!usable.length) return Number.NaN;
  const z = usable.reduce((a, r) => a + atanh(r), 0) / usable.length;
  return Math.tanh(z);
}

const stdev = (xs: readonly number[]): number => {
  const u = xs.filter((v) => Number.isFinite(v));
  if (u.length < 2) return 0;
  const m = u.reduce((a, b) => a + b, 0) / u.length;
  return Math.sqrt(u.reduce((a, b) => a + (b - m) ** 2, 0) / (u.length - 1));
};

const pool = (rhos: readonly number[]): PooledRho => ({
  rho: fisherMean(rhos),
  sd: stdev(rhos),
  windows: rhos.filter((r) => Number.isFinite(r)).length,
});

/** Pearson correlation over a slice; NaN if either leg is flat. */
function sliceCorr(a: readonly number[], b: readonly number[], from: number, to: number): number {
  let n = 0;
  let sa = 0;
  let sb = 0;
  for (let i = from; i < to; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sa += x!;
    sb += y!;
    n++;
  }
  if (n < 3) return Number.NaN;
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = from; i < to; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    num += (x! - ma) * (y! - mb);
    da += (x! - ma) ** 2;
    db += (y! - mb) ** 2;
  }
  if (!(da > 0) || !(db > 0)) return Number.NaN;
  return num / Math.sqrt(da * db);
}

/**
 * Log returns per symbol, truncated to the shortest usable series so every
 * window compares the same bars. Absolute-return basis takes |r| afterwards.
 */
export function returnSeries(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  basis: CalibrationBasis = DEFAULTS.basis,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [sym, closes] of seriesBySymbol) {
    if (closes.length < 3) continue;
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const prev = closes[i - 1]!;
      const cur = closes[i]!;
      const r = prev > 0 && cur > 0 ? Math.log(cur / prev) : Number.NaN;
      rets.push(basis === "absReturns" ? Math.abs(r) : r);
    }
    out.set(sym, rets);
  }
  return out;
}

// --------------------------------------------------------------- calibration

/**
 * Rolling within/across correlation estimates, one row per window, each tagged
 * calm or stressed. This is the time series to plot when you want to see the
 * coupling assumption move rather than a single pooled number.
 */
export function rollingCorrelationWindows(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  opts: CalibrationOptions = {},
): RollingCorrelationWindow[] {
  const window = Math.max(5, Math.floor(opts.window ?? DEFAULTS.window));
  const step = Math.max(1, Math.floor(opts.step ?? DEFAULTS.step));
  const stressZ = opts.stressZ ?? DEFAULTS.stressZ;
  const minStressShare = opts.minStressShare ?? DEFAULTS.minStressShare;
  const rets = returnSeries(seriesBySymbol, opts.basis ?? DEFAULTS.basis);
  const symbols = [...rets.keys()];
  if (symbols.length < 2) return [];
  const groups = opts.groups ?? new Map(symbols.map((s) => [s, defaultCluster(s)]));
  const groupOf = (s: string) => groups.get(s) ?? "other";
  const n = Math.min(...symbols.map((s) => rets.get(s)!.length));
  if (n < window) return [];
  // volZ is indexed by close; returns are offset by one bar.
  const volZ = opts.volZ ?? [];

  const rows: RollingCorrelationWindow[] = [];
  for (let end = window; end <= n; end += step) {
    const from = end - window;
    const within: number[] = [];
    const across: number[] = [];
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const a = symbols[i]!;
        const b = symbols[j]!;
        const r = sliceCorr(rets.get(a)!, rets.get(b)!, from, end);
        if (!Number.isFinite(r)) continue;
        (groupOf(a) === groupOf(b) ? within : across).push(r);
      }
    }
    let stressBars = 0;
    let counted = 0;
    for (let i = from; i < end; i++) {
      const z = volZ[i + 1];
      if (z === undefined) continue;
      counted++;
      if (z >= stressZ) stressBars++;
    }
    const stressShare = counted ? stressBars / counted : 0;
    rows.push({
      endIndex: end,
      bars: window,
      withinRho: fisherMean(within),
      acrossRho: fisherMean(across),
      withinPairs: within.length,
      acrossPairs: across.length,
      stressShare,
      stressed: stressShare >= minStressShare,
    });
  }
  return rows;
}

/**
 * Pools the rolling windows into calm and stress coupling estimates. The result
 * feeds `structureFromCalibration` but is worth reading on its own: the `sd`
 * fields say how stable each number is, and a stress bucket with two windows in
 * it is not an estimate, it is an anecdote.
 */
export function calibrateCorrelations(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  opts: CalibrationOptions = {},
): CorrelationCalibration {
  const basis = opts.basis ?? DEFAULTS.basis;
  const window = Math.max(5, Math.floor(opts.window ?? DEFAULTS.window));
  const step = Math.max(1, Math.floor(opts.step ?? DEFAULTS.step));
  const shrink = Math.min(1, Math.max(0, opts.shrink ?? DEFAULTS.shrink));
  const rows = rollingCorrelationWindows(seriesBySymbol, { ...opts, basis, window, step });
  const symbols = [...seriesBySymbol.keys()];
  const groups = opts.groups ?? new Map(symbols.map((s) => [s, defaultCluster(s)]));

  const calmRows = rows.filter((r) => !r.stressed);
  const stressRows = rows.filter((r) => r.stressed);
  const scale = (p: PooledRho): PooledRho => ({
    ...p,
    rho: Number.isFinite(p.rho) ? p.rho * shrink : p.rho,
    sd: p.sd * shrink,
  });

  return {
    basis,
    window,
    step,
    shrink,
    symbols,
    clusters: [...new Set(symbols.map((s) => groups.get(s) ?? "other"))].sort(),
    windows: rows,
    calm: {
      within: scale(pool(calmRows.map((r) => r.withinRho))),
      across: scale(pool(calmRows.map((r) => r.acrossRho))),
    },
    stress: {
      within: scale(pool(stressRows.map((r) => r.withinRho))),
      across: scale(pool(stressRows.map((r) => r.acrossRho))),
    },
    stressShare: rows.length ? stressRows.length / rows.length : 0,
  };
}

/**
 * Turns a calibration into a usable structure. Negative pooled correlations are
 * floored at 0 (the factor decomposition has no meaning below zero), and any
 * regime with no windows falls back to the calm estimate, so a tape with no
 * stress episodes yields `blocks`, not a fabricated contagion.
 */
export function structureFromCalibration(
  cal: CorrelationCalibration,
  kind: Extract<CorrelationStructureKind, "blocks" | "contagion"> = "contagion",
  groups?: ReadonlyMap<string, string>,
): CorrelationStructure {
  const clean = (v: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
  const within = clean(cal.calm.within.rho, 0.3);
  const across = Math.min(within, clean(cal.calm.across.rho, within * 0.4));
  const hasStress = cal.stress.within.windows > 0 || cal.stress.across.windows > 0;
  const stressWithin = hasStress ? Math.max(within, clean(cal.stress.within.rho, within)) : within;
  const stressAcross = hasStress
    ? Math.min(stressWithin, Math.max(across, clean(cal.stress.across.rho, across)))
    : across;

  return makeCorrelationStructure({
    kind,
    withinRho: within,
    acrossRho: across,
    stressWithinRho: kind === "contagion" ? stressWithin : within,
    stressAcrossRho: kind === "contagion" ? stressAcross : across,
    groups: groups
      ?? new Map(cal.symbols.map((s) => [s, defaultCluster(s)])),
  });
}

const fmt = (p: PooledRho) =>
  Number.isFinite(p.rho)
    ? `${p.rho.toFixed(3)} ±${p.sd.toFixed(3)} (n=${p.windows})`
    : `n/a (n=0)`;

/** Human-readable summary for the report header. */
export function describeCalibration(cal: CorrelationCalibration): string {
  return [
    `basis=${cal.basis} window=${cal.window} step=${cal.step}`
      + (cal.shrink !== 1 ? ` shrink=${cal.shrink}` : ""),
    `clusters: ${cal.clusters.join(", ")}`,
    `windows: ${cal.windows.length} (${(cal.stressShare * 100).toFixed(1)}% stressed)`,
    `calm   within ${fmt(cal.calm.within)}   across ${fmt(cal.calm.across)}`,
    `stress within ${fmt(cal.stress.within)}   across ${fmt(cal.stress.across)}`,
  ].join("\n");
}
