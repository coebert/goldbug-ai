// Sensitivity of the correlation calibration to the calm→stress boundary.
//
// Every number in the calibration rests on one editorial decision: which
// windows count as "stressed". The hard rule (a bar is stressed at z ≥ 1.5, a
// window is stressed when a quarter of its bars are) is a cliff. A window at
// 24% of stressed bars contributes nothing to the stress estimate and
// everything to the calm one; its neighbour at 26% does the opposite. With a
// stress bucket of a few dozen overlapping windows, that cliff is not a
// rounding detail — it is a live degree of freedom in the fitted ρ.
//
// `blend` softens the cliff into a ramp (see `CalibrationOptions.blend`). This
// module sweeps it and reports what moves:
//
//   - the size of each regime sample (stress window mass),
//   - the fitted calm/stress ρ on both legs, and the stress − calm separation,
//   - rolling-fit stability (sd, coefficient of variation, drift),
//   - bootstrap interval widths and effective sample size,
//   - residual correlation error for `blocks` and `contagion`.
//
// The question it answers is not "which blend is right" — no blend is right —
// but "does the conclusion survive the choice". A stress ρ that slides steadily
// with the blend is a fitted artefact of the labelling rule; one that sits
// still is a property of the tape.

import {
  diagnoseCalibrationFit,
  type CalibrationDiagnostics,
  type DiagnosticsOptions,
} from "./execution-correlation-diagnostics";
import type { CorrelationStructureKind } from "./execution-correlation-structures";

/** Blends swept when the caller does not name any. */
export const DEFAULT_BLEND_GRID: readonly number[] = [0, 0.1, 0.25, 0.5, 1];

export type BlendResidual = {
  kind: CorrelationStructureKind;
  rmse: number;
  weightedRmse: number;
  bias: number;
  rmseCalm: number;
  rmseStress: number;
};

export type BlendSweepPoint = {
  blend: number;
  /** Windows in the rolling fit (identical across blends — only labels move). */
  windows: number;
  /** Windows whose stress weight is ≥ 0.5 — the hard-label count. */
  stressWindows: number;
  /** Σ stress weight: the fractional stress sample the pooling actually used. */
  stressMass: number;
  /** Windows strictly between calm and stressed, i.e. the ones the blend created. */
  partialWindows: number;
  calmWithin: number;
  calmAcross: number;
  stressWithin: number;
  stressAcross: number;
  /** stress − calm on each leg: the contagion signal. */
  withinSeparation: number;
  acrossSeparation: number;
  /** Bootstrap CI width on the across-cluster separation (the contagion test). */
  acrossSeparationCiWidth: number;
  acrossSeparationLo: number;
  acrossSeparationHi: number;
  contagionSupported: boolean;
  /** Effective (overlap-discounted) sample behind the stress-within estimate. */
  stressEffN: number;
  /** Rolling stability of the stress-labelled within-cluster series. */
  stressWithinSd: number;
  stressWithinCoefVar: number;
  stressWithinDrift: number;
  /** Same for the calm side, as the stable-by-construction control. */
  calmWithinSd: number;
  calmWithinCoefVar: number;
  residuals: BlendResidual[];
  bestFit: CorrelationStructureKind | null;
  diagnostics: CalibrationDiagnostics;
};

/** Range of one metric over the swept blends. */
export type BlendSpread = {
  metric: string;
  min: number;
  max: number;
  /** max − min: how much the blend choice alone moves this number. */
  range: number;
  /** Blend at the minimum / maximum. */
  argMin: number;
  argMax: number;
  /** Spearman rank correlation with the blend — ±1 means a clean monotone slide. */
  monotonicity: number;
};

export type BlendSweepVerdict = "stable" | "sensitive" | "fragile";

export type RegimeBlendSweep = {
  points: BlendSweepPoint[];
  spreads: BlendSpread[];
  /** Blend at which the residual fit is best (lowest weighted RMSE, best kind). */
  bestBlend: number | null;
  /** True when every blend agrees on which structure fits best. */
  bestFitStable: boolean;
  /** True when every blend agrees on the contagion test. */
  contagionVerdictStable: boolean;
  verdict: BlendSweepVerdict;
  notes: string[];
};

// ------------------------------------------------------------------ plumbing

const finite = (xs: readonly number[]) => xs.filter((x) => Number.isFinite(x));

const rank = (xs: readonly number[]): number[] => {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]![1]] = avg;
    i = j + 1;
  }
  return out;
};

/** Spearman rank correlation; 0 when either side is constant. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  const pairs = a
    .map((v, i) => [v, b[i]] as const)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y as number)) as Array<
    readonly [number, number]
  >;
  if (pairs.length < 3) return Number.NaN;
  const ra = rank(pairs.map((p) => p[0]));
  const rb = rank(pairs.map((p) => p[1]));
  const m = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = m(ra);
  const mb = m(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function spreadOf(
  metric: string,
  points: readonly BlendSweepPoint[],
  pick: (p: BlendSweepPoint) => number,
): BlendSpread {
  const usable = points.filter((p) => Number.isFinite(pick(p)));
  if (!usable.length) {
    return {
      metric, min: Number.NaN, max: Number.NaN, range: Number.NaN,
      argMin: Number.NaN, argMax: Number.NaN, monotonicity: Number.NaN,
    };
  }
  const lo = usable.reduce((b, p) => (pick(p) < pick(b) ? p : b));
  const hi = usable.reduce((b, p) => (pick(p) > pick(b) ? p : b));
  return {
    metric,
    min: pick(lo),
    max: pick(hi),
    range: pick(hi) - pick(lo),
    argMin: lo.blend,
    argMax: hi.blend,
    monotonicity: spearman(usable.map((p) => p.blend), usable.map(pick)),
  };
}

const residualOf = (p: BlendSweepPoint, kind: CorrelationStructureKind) =>
  p.residuals.find((r) => r.kind === kind);

// -------------------------------------------------------------------- sweep

export type BlendSweepOptions = Omit<DiagnosticsOptions, "blend"> & {
  /** Blends to fit. Duplicates are collapsed; the grid is sorted ascending. */
  blends?: readonly number[];
};

/**
 * Refits the calibration once per blend and summarises the movement.
 *
 * Everything except the regime labelling is held fixed — same bars, same
 * windows, same estimator — so any difference between two rows is caused by
 * the boundary softness and nothing else.
 */
export function sweepRegimeBlend(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  opts: BlendSweepOptions = {},
): RegimeBlendSweep {
  const grid = [...new Set((opts.blends ?? DEFAULT_BLEND_GRID).map((b) => Math.max(0, b)))]
    .sort((a, b) => a - b);

  const points: BlendSweepPoint[] = grid.map((blend) => {
    const d = diagnoseCalibrationFit(seriesBySymbol, { ...opts, blend });
    const cal = d.calibration;
    const rows = cal.windows;
    const partial = rows.filter((r) => r.stressWeight > 1e-9 && r.stressWeight < 1 - 1e-9).length;
    const sep = d.confidence.acrossSeparation;

    return {
      blend,
      windows: rows.length,
      stressWindows: rows.filter((r) => r.stressed).length,
      stressMass: cal.stressMass,
      partialWindows: partial,
      calmWithin: cal.calm.within.rho,
      calmAcross: cal.calm.across.rho,
      stressWithin: cal.stress.within.rho,
      stressAcross: cal.stress.across.rho,
      withinSeparation: cal.stress.within.rho - cal.calm.within.rho,
      acrossSeparation: cal.stress.across.rho - cal.calm.across.rho,
      acrossSeparationCiWidth: sep.hi - sep.lo,
      acrossSeparationLo: sep.lo,
      acrossSeparationHi: sep.hi,
      contagionSupported: d.contagionSupported,
      stressEffN: d.confidence.stressWithin.effN,
      stressWithinSd: d.stability.stressWithin.sd,
      stressWithinCoefVar: d.stability.stressWithin.coefVar,
      stressWithinDrift: d.stability.stressWithin.drift,
      calmWithinSd: d.stability.calmWithin.sd,
      calmWithinCoefVar: d.stability.calmWithin.coefVar,
      residuals: d.structures.map((s) => ({
        kind: s.kind,
        rmse: s.residuals.rmse,
        weightedRmse: s.residuals.weightedRmse,
        bias: s.residuals.bias,
        rmseCalm: s.residuals.rmseCalm,
        rmseStress: s.residuals.rmseStress,
      })),
      bestFit: d.bestFit,
      diagnostics: d,
    };
  });

  const spreads: BlendSpread[] = [
    spreadOf("calm within ρ", points, (p) => p.calmWithin),
    spreadOf("calm across ρ", points, (p) => p.calmAcross),
    spreadOf("stress within ρ", points, (p) => p.stressWithin),
    spreadOf("stress across ρ", points, (p) => p.stressAcross),
    spreadOf("across separation", points, (p) => p.acrossSeparation),
    spreadOf("stress mass", points, (p) => p.stressMass),
    spreadOf("stress effN", points, (p) => p.stressEffN),
    spreadOf("stress within sd", points, (p) => p.stressWithinSd),
    spreadOf("sep CI width", points, (p) => p.acrossSeparationCiWidth),
    spreadOf("rmse blocks", points, (p) => residualOf(p, "blocks")?.weightedRmse ?? Number.NaN),
    spreadOf("rmse contagion", points, (p) => residualOf(p, "contagion")?.weightedRmse ?? Number.NaN),
  ];

  const best = points
    .filter((p) => p.residuals.some((r) => Number.isFinite(r.weightedRmse)))
    .map((p) => ({
      blend: p.blend,
      rmse: Math.min(
        ...p.residuals.map((r) => (Number.isFinite(r.weightedRmse) ? r.weightedRmse : Infinity)),
      ),
    }))
    .sort((a, b) => a.rmse - b.rmse)[0];

  const fits = new Set(points.map((p) => p.bestFit));
  const verdicts = new Set(points.map((p) => p.contagionSupported));
  const bestFitStable = fits.size <= 1;
  const contagionVerdictStable = verdicts.size <= 1;

  const stressRange = spreads.find((s) => s.metric === "stress within ρ")?.range ?? Number.NaN;
  const sepRange = spreads.find((s) => s.metric === "across separation")?.range ?? Number.NaN;
  const rmseRange = Math.max(
    ...finite([
      spreads.find((s) => s.metric === "rmse blocks")?.range ?? Number.NaN,
      spreads.find((s) => s.metric === "rmse contagion")?.range ?? Number.NaN,
    ]),
    0,
  );

  // A conclusion that flips with the labelling rule is fragile regardless of
  // how small the ρ movement looks.
  let verdict: BlendSweepVerdict = "stable";
  if (!bestFitStable || !contagionVerdictStable) verdict = "fragile";
  else if (stressRange > 0.1 || sepRange > 0.1 || rmseRange > 0.05) verdict = "sensitive";

  const notes: string[] = [];
  if (!contagionVerdictStable) {
    const on = points.filter((p) => p.contagionSupported).map((p) => p.blend);
    notes.push(
      `The contagion test flips with the blend — supported at ${on.join(", ") || "none"} `
      + "and not elsewhere. The separation is a labelling artefact at this sample size.",
    );
  }
  if (!bestFitStable) {
    notes.push(
      `Best-fitting structure changes across blends (${[...fits].map(String).join(" → ")}), `
      + "so the structure choice is not identified by residual error alone.",
    );
  }
  if (Number.isFinite(stressRange) && stressRange > 0.1) {
    notes.push(
      `Stress within-ρ moves ${stressRange.toFixed(3)} across the grid; treat it as a range, `
      + "not a point estimate.",
    );
  }
  const massSpread = spreads.find((s) => s.metric === "stress mass");
  if (massSpread && Number.isFinite(massSpread.range) && massSpread.range > 0) {
    notes.push(
      `Stress sample mass runs ${massSpread.min.toFixed(1)}→${massSpread.max.toFixed(1)} windows; `
      + "softer blends buy sample size by diluting what 'stressed' means.",
    );
  }
  if (verdict === "stable") {
    notes.push("Every fitted number and both verdicts survive the boundary choice.");
  }

  return {
    points,
    spreads,
    bestBlend: best?.blend ?? null,
    bestFitStable,
    contagionVerdictStable,
    verdict,
    notes,
  };
}

// ------------------------------------------------------------------ printing

const num = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");

/** Terminal report for the blend sweep. */
export function formatRegimeBlendSweep(s: RegimeBlendSweep): string {
  const lines: string[] = [];

  lines.push("Regime-blend sensitivity — fitted coupling per boundary softness");
  lines.push([
    "blend".padStart(6), "stressW".padStart(8), "mass".padStart(7), "partial".padStart(8),
    "calmIn".padStart(7), "calmX".padStart(7), "strIn".padStart(7), "strX".padStart(7),
    "sepX".padStart(7), "effN".padStart(6),
  ].join(" "));
  for (const p of s.points) {
    lines.push([
      p.blend.toFixed(2).padStart(6), String(p.stressWindows).padStart(8),
      p.stressMass.toFixed(1).padStart(7), String(p.partialWindows).padStart(8),
      num(p.calmWithin).padStart(7), num(p.calmAcross).padStart(7),
      num(p.stressWithin).padStart(7), num(p.stressAcross).padStart(7),
      num(p.acrossSeparation).padStart(7), p.stressEffN.toFixed(1).padStart(6),
    ].join(" "));
  }

  lines.push("");
  lines.push("Stability and fit error per blend");
  lines.push([
    "blend".padStart(6), "strSd".padStart(7), "strCV".padStart(7), "drift".padStart(7),
    "calmSd".padStart(7), "sepCI".padStart(17), "rmseBlk".padStart(8), "rmseCtg".padStart(8),
    "best".padStart(10), "contagion".padStart(10),
  ].join(" "));
  for (const p of s.points) {
    const blk = p.residuals.find((r) => r.kind === "blocks");
    const ctg = p.residuals.find((r) => r.kind === "contagion");
    lines.push([
      p.blend.toFixed(2).padStart(6), num(p.stressWithinSd).padStart(7),
      num(p.stressWithinCoefVar, 2).padStart(7), num(p.stressWithinDrift).padStart(7),
      num(p.calmWithinSd).padStart(7),
      `[${num(p.acrossSeparationLo)}, ${num(p.acrossSeparationHi)}]`.padStart(17),
      num(blk?.weightedRmse ?? Number.NaN).padStart(8),
      num(ctg?.weightedRmse ?? Number.NaN).padStart(8),
      String(p.bestFit ?? "n/a").padStart(10),
      (p.contagionSupported ? "yes" : "no").padStart(10),
    ].join(" "));
  }

  lines.push("");
  lines.push("Spread attributable to the blend choice alone");
  lines.push([
    "metric".padEnd(20), "min".padStart(8), "max".padStart(8),
    "range".padStart(8), "argMin".padStart(7), "argMax".padStart(7), "mono".padStart(6),
  ].join(" "));
  for (const sp of s.spreads) {
    lines.push([
      sp.metric.padEnd(20), num(sp.min).padStart(8), num(sp.max).padStart(8),
      num(sp.range).padStart(8), num(sp.argMin, 2).padStart(7), num(sp.argMax, 2).padStart(7),
      num(sp.monotonicity, 2).padStart(6),
    ].join(" "));
  }

  lines.push("");
  lines.push(`Verdict: ${s.verdict.toUpperCase()}`
    + (s.bestBlend !== null ? ` · lowest residual error at blend ${s.bestBlend.toFixed(2)}` : ""));
  for (const n of s.notes) lines.push(`  - ${n}`);
  return lines.join("\n");
}
