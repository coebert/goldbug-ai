// Phase 3 item 13 — cross-sectional orthogonalisation of correlated scorers.
//
// Trend, breakout and mean-reversion all read the same price series, so their
// scores co-move. Blending them raw double-counts one idea: a symbol in a
// strong uptrend gets paid by trend *and* by breakout, and the composite ends
// up far more trend-levered than the regime weights imply.
//
// The fix is a cross-sectional residualisation. For each (target, base) pair
// we regress the target's scores on the base's scores *across the universe on
// this tick*, and keep only the residual — the part of the target that trend
// (or whichever base) does not already explain. The residual is rescaled to
// the target's original dispersion so weights stay comparable, then clamped.
//
// Design rules:
//   - Pure and deterministic; operates on one tick's universe at a time.
//   - Regressions run against the ORIGINAL base scores, never the residuals of
//     an earlier pair, so the order of pairs cannot cascade.
//   - Guards: needs MIN_OBS symbols with both scores present, and only fires
//     when |correlation| >= MIN_ABS_CORR. Otherwise the target is untouched.
//   - Beta is shrunk toward 0 by the correlation strength, so a weak overlap
//     removes little.
import { clamp1, type AlphaModelKind } from "./types";

export type ModelScoreRow = Partial<Record<AlphaModelKind, number>>;

export type OrthogonalisationPair = {
  /** Model whose score gets residualised. */
  target: AlphaModelKind;
  /** Model(s) whose explained part is removed from the target. */
  against: AlphaModelKind;
};

/**
 * Default overlap map. Trend is the reference factor: breakout and
 * mean-reversion are both price-series derivatives of it. Carry is
 * residualised against quality because low-vol dividend payers score well on
 * both for the same underlying reason.
 */
export const DEFAULT_ORTHOGONALISATION: OrthogonalisationPair[] = [
  { target: "breakout", against: "trend" },
  { target: "mean_reversion", against: "trend" },
  { target: "carry", against: "quality" },
];

/** Minimum universe size before a cross-sectional regression is trustworthy. */
export const MIN_OBS = 8;
/** Below this |r| the overlap is noise and the target is left alone. */
export const MIN_ABS_CORR = 0.3;

export type OrthogonalisationDiagnostic = {
  target: AlphaModelKind;
  against: AlphaModelKind;
  obs: number;
  corr: number;
  beta: number;
  applied: boolean;
  reason: string;
};

export type OrthogonalisationResult = {
  rows: ModelScoreRow[];
  diagnostics: OrthogonalisationDiagnostic[];
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/**
 * Residualise each configured target model against its base model across the
 * universe. Returns new rows — inputs are never mutated.
 */
export function orthogonaliseScores(
  rows: ModelScoreRow[],
  pairs: OrthogonalisationPair[] = DEFAULT_ORTHOGONALISATION,
): OrthogonalisationResult {
  const out: ModelScoreRow[] = rows.map((r) => ({ ...r }));
  const diagnostics: OrthogonalisationDiagnostic[] = [];

  for (const pair of pairs) {
    // Index of every symbol that has BOTH scores, read from the originals.
    const idx: number[] = [];
    const ys: number[] = [];
    const xs: number[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const y = rows[i]?.[pair.target];
      const x = rows[i]?.[pair.against];
      if (typeof y !== "number" || !Number.isFinite(y)) continue;
      if (typeof x !== "number" || !Number.isFinite(x)) continue;
      idx.push(i);
      ys.push(y);
      xs.push(x);
    }

    const obs = idx.length;
    if (obs < MIN_OBS) {
      diagnostics.push({
        target: pair.target, against: pair.against, obs, corr: 0, beta: 0,
        applied: false, reason: `only ${obs} paired scores (need ${MIN_OBS})`,
      });
      continue;
    }

    const sx = stdev(xs);
    const sy = stdev(ys);
    if (sx <= 1e-9 || sy <= 1e-9) {
      diagnostics.push({
        target: pair.target, against: pair.against, obs, corr: 0, beta: 0,
        applied: false, reason: "no dispersion to regress on",
      });
      continue;
    }

    const mx = mean(xs);
    const my = mean(ys);
    let cov = 0;
    for (let i = 0; i < obs; i += 1) cov += (xs[i]! - mx) * (ys[i]! - my);
    cov /= obs - 1;
    const corr = cov / (sx * sy);

    if (Math.abs(corr) < MIN_ABS_CORR) {
      diagnostics.push({
        target: pair.target, against: pair.against, obs, corr, beta: 0,
        applied: false, reason: `overlap too weak (r=${corr.toFixed(2)})`,
      });
      continue;
    }

    // Shrink beta by |r|: a marginal overlap only strips a marginal amount.
    const beta = (cov / (sx * sx)) * Math.abs(corr);

    const residuals = ys.map((y, i) => y - my - beta * (xs[i]! - mx));
    const sr = stdev(residuals);
    // Rescale so the residual keeps the target's original dispersion —
    // orthogonalisation should remove overlap, not silently shrink the model's
    // weight in the composite.
    const rescale = sr > 1e-9 ? sy / sr : 1;

    for (let i = 0; i < obs; i += 1) {
      const row = out[idx[i]!]!;
      row[pair.target] = clamp1(my + residuals[i]! * rescale);
    }

    diagnostics.push({
      target: pair.target, against: pair.against, obs, corr, beta,
      applied: true,
      reason: `${pair.target} ⟂ ${pair.against}: r=${corr.toFixed(2)}, β=${beta.toFixed(2)} removed`,
    });
  }

  return { rows: out, diagnostics };
}

/** One-line audit summary of what was stripped. */
export function describeOrthogonalisation(diags: OrthogonalisationDiagnostic[]): string {
  const applied = diags.filter((d) => d.applied);
  if (applied.length === 0) return "orthogonalisation: no material overlap";
  return `orthogonalisation: ${applied.map((d) => d.reason).join("; ")}`;
}
