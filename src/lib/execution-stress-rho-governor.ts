// Risk control: scale the stress ρ_within term by how well it is estimated.
//
// The calibration reports a single stress ρ_within. Under contagion that number
// does most of the damage in the tail: it is the coupling the simulator uses
// exactly when everything is already going wrong. But stress buckets are small
// and overlapping, so the point estimate is often an anecdote wearing a decimal
// point — the Aug 2026 robustness work put the honest range at 0.40–0.60.
//
// This module refuses to let a fragile estimate act at full strength. It takes
// the moving-block bootstrap CI on the stressed windows and turns its width
// into a credibility weight in [0, 1], then shrinks the stress lift (stress
// ρ_within − calm ρ_within) by that weight before it reaches the structure:
//
//   governed = calm + credibility × min(lift, maxLift)
//
// A tight interval (width ≤ `tightWidth`) keeps the full lift; a wide one
// (width ≥ `fullWidth`) collapses the structure back to the calm coupling,
// which is the same fallback a stress-starved tape already gets. A small
// effective sample size discounts credibility further, because a narrow CI
// computed from four independent windows is narrow by luck.
//
// Pure and deterministic: same calibration + same seed ⇒ same governance.

import {
  structureFromCalibration,
  type CorrelationCalibration,
} from "./execution-correlation-calibration";
import {
  bootstrapRhoCI,
  type BootstrapOptions,
  type ConfidenceInterval,
} from "./execution-correlation-diagnostics";
import type {
  CorrelationStructure,
  CorrelationStructureKind,
} from "./execution-correlation-structures";

export type StressRhoGovernorOptions = BootstrapOptions & {
  /** CI width at or below which the stress estimate is trusted fully. Default 0.10. */
  tightWidth?: number;
  /** CI width at or above which the stress estimate is ignored. Default 0.35. */
  fullWidth?: number;
  /** Independent stressed windows needed for full credit. Default 6. */
  minEffN?: number;
  /** Hard cap on the stress lift before weighting, in ρ units. Default 0.35. */
  maxLift?: number;
  /** Floor on the weight once the estimate clears the effN bar. Default 0. */
  minCredibility?: number;
  /** Set false to report governance without changing the structure. Default true. */
  enabled?: boolean;
};

export type StressRhoGovernance = {
  enabled: boolean;
  calmWithin: number;
  /** Stress ρ_within straight out of the calibration. */
  rawStressWithin: number;
  /** Stress ρ_within after CI-width weighting — what the structure should use. */
  governedStressWithin: number;
  /** Bootstrap CI on the stressed-window ρ_within series. */
  ci: ConfidenceInterval;
  /** hi − lo of that CI; NaN when there was nothing to bootstrap. */
  ciWidth: number;
  /** Independent-window count behind the CI (overlap-discounted). */
  effN: number;
  /** Stressed windows in the calibration. */
  stressWindows: number;
  /** Raw lift (raw stress − calm), before cap and weighting. */
  rawLift: number;
  /** Lift actually applied. */
  appliedLift: number;
  /** Weight in [0, 1] applied to the capped lift. */
  credibility: number;
  /** Component weights, for the report. */
  widthCredibility: number;
  sampleCredibility: number;
  /** Plain-language reasons the weight is what it is. */
  notes: string[];
};

const DEFAULTS = {
  tightWidth: 0.10,
  fullWidth: 0.35,
  minEffN: 6,
  maxLift: 0.35,
  minCredibility: 0,
} as const;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Scores the stress ρ_within estimate and returns the governed value.
 *
 * Fails safe in every degenerate case: no stressed windows, a non-finite
 * estimate or a bootstrap that could not run all collapse to the calm
 * coupling rather than passing an unverified number to the simulator.
 */
export function governStressWithinRho(
  cal: CorrelationCalibration,
  opts: StressRhoGovernorOptions = {},
): StressRhoGovernance {
  const enabled = opts.enabled ?? true;
  const tightWidth = Math.max(0, opts.tightWidth ?? DEFAULTS.tightWidth);
  const fullWidth = Math.max(tightWidth + 1e-6, opts.fullWidth ?? DEFAULTS.fullWidth);
  const minEffN = Math.max(1, opts.minEffN ?? DEFAULTS.minEffN);
  const maxLift = Math.max(0, opts.maxLift ?? DEFAULTS.maxLift);
  const minCredibility = clamp01(opts.minCredibility ?? DEFAULTS.minCredibility);

  const calmRaw = cal.calm.within.rho;
  const calmWithin = Number.isFinite(calmRaw) ? Math.min(1, Math.max(0, calmRaw)) : 0.3;
  const rawStressRaw = cal.stress.within.rho;
  const rawStressWithin = Number.isFinite(rawStressRaw)
    ? Math.min(1, Math.max(0, rawStressRaw))
    : calmWithin;

  const stressRows = cal.windows.filter((w) => w.stressed && Number.isFinite(w.withinRho));
  const stressWindows = stressRows.length;
  // Overlapping rolling windows: block length = the overlap span, so the
  // bootstrap does not count the same bars as independent evidence.
  const blockSize = opts.blockSize ?? Math.max(1, Math.ceil(cal.window / Math.max(1, cal.step)));
  const ci = bootstrapRhoCI(stressRows.map((w) => w.withinRho), { ...opts, blockSize });
  const ciWidth = Number.isFinite(ci.hi) && Number.isFinite(ci.lo) ? ci.hi - ci.lo : Number.NaN;

  const notes: string[] = [];
  const rawLift = Math.max(0, rawStressWithin - calmWithin);

  let widthCredibility = 0;
  if (Number.isFinite(ciWidth)) {
    widthCredibility = clamp01((fullWidth - ciWidth) / (fullWidth - tightWidth));
    if (widthCredibility <= 0) {
      notes.push(`CI width ${ciWidth.toFixed(3)} ≥ ${fullWidth.toFixed(2)}: stress lift ignored.`);
    } else if (widthCredibility < 1) {
      notes.push(`CI width ${ciWidth.toFixed(3)} between ${tightWidth.toFixed(2)} and `
        + `${fullWidth.toFixed(2)}: lift scaled to ${(widthCredibility * 100).toFixed(0)}%.`);
    }
  } else {
    notes.push("No usable bootstrap CI on stressed windows: stress lift ignored.");
  }

  const sampleCredibility = clamp01(ci.effN / minEffN);
  if (sampleCredibility < 1) {
    notes.push(`Effective stressed sample ${ci.effN.toFixed(1)} < ${minEffN}: `
      + `lift scaled by a further ${(sampleCredibility * 100).toFixed(0)}%.`);
  }

  let credibility = widthCredibility * sampleCredibility;
  if (stressWindows === 0) {
    credibility = 0;
    notes.push("No stressed windows in the fit: falling back to the calm coupling.");
  } else if (credibility > 0) {
    credibility = Math.max(credibility, minCredibility);
  }
  credibility = clamp01(credibility);

  const cappedLift = Math.min(rawLift, maxLift);
  if (rawLift > maxLift) {
    notes.push(`Raw lift ${rawLift.toFixed(3)} capped at ${maxLift.toFixed(2)} before weighting.`);
  }
  const appliedLift = enabled ? cappedLift * credibility : rawLift;
  const governedStressWithin = Math.min(1, calmWithin + appliedLift);
  if (!enabled) notes.push("Governor disabled: raw stress ρ_within passed through.");
  if (notes.length === 0) notes.push("Stress estimate is tight and well sampled: full lift applied.");

  return {
    enabled,
    calmWithin,
    rawStressWithin,
    governedStressWithin,
    ci,
    ciWidth,
    effN: ci.effN,
    stressWindows,
    rawLift,
    appliedLift,
    credibility: enabled ? credibility : 1,
    widthCredibility,
    sampleCredibility,
    notes,
  };
}

/**
 * `structureFromCalibration` with the stress ρ_within term governed.
 *
 * ρ_across is dragged along by the same weight: the structure requires
 * stress ρ_across ≤ stress ρ_within, and leaving across at full strength while
 * within shrinks would invert the cluster geometry.
 */
export function governedStructureFromCalibration(
  cal: CorrelationCalibration,
  kind: Extract<CorrelationStructureKind, "blocks" | "contagion"> = "contagion",
  groups?: ReadonlyMap<string, string>,
  opts: StressRhoGovernorOptions = {},
): { structure: CorrelationStructure; governance: StressRhoGovernance } {
  const governance = governStressWithinRho(cal, opts);
  const calmAcross = Number.isFinite(cal.calm.across.rho) ? cal.calm.across.rho : 0;
  const rawAcross = Number.isFinite(cal.stress.across.rho) ? cal.stress.across.rho : calmAcross;
  const acrossLift = Math.max(0, rawAcross - calmAcross) * governance.credibility;
  return {
    structure: structureFromCalibration(cal, kind, groups, {
      stressWithinRho: governance.governedStressWithin,
      stressAcrossRho: Math.min(governance.governedStressWithin, calmAcross + acrossLift),
    }),
    governance,
  };
}

/** Report block for the Monte-Carlo console output. */
export function formatStressRhoGovernance(g: StressRhoGovernance): string {
  const n = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
  return [
    "Stress ρ_within risk control (CI-width weighted)",
    `  calm ρ_within      ${n(g.calmWithin)}`,
    `  raw stress ρ_within ${n(g.rawStressWithin)}  (lift ${n(g.rawLift)})`,
    `  bootstrap CI       [${n(g.ci.lo)}, ${n(g.ci.hi)}] width ${n(g.ciWidth)} `
      + `effN ${n(g.effN, 1)} over ${g.stressWindows} stressed windows`,
    `  credibility        ${n(g.credibility, 2)} `
      + `(width ${n(g.widthCredibility, 2)} × sample ${n(g.sampleCredibility, 2)})`,
    `  governed stress ρ  ${n(g.governedStressWithin)}  (lift ${n(g.appliedLift)})`,
    ...g.notes.map((t) => `  · ${t}`),
  ].join("\n");
}
