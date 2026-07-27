// Phase G+ — Auto-tuning for the algo-regime detector.
//
// Pure translator: takes a realised calibration report + the currently
// active AlgoRegimeConfig and returns a *bounded* proposed config plus
// human-readable notes describing what changed and why. No I/O.
//
// Design goals:
//   * Only ever nudge — bounded step sizes, hard clamps at both ends.
//   * Refuse to tune on thin samples (avoid overfitting a handful of days).
//   * Never make the guard SILENTLY looser; every loosening step is logged
//     in `notes` so an operator can audit the change.
//   * Steps and clamps SCALE with the portfolio's risk level: aggressive
//     portfolios accept wider bounds and larger nudges; conservative
//     portfolios stay near defaults with small nudges and refuse to drift
//     far enough to invert the tier ladder.

import {
  DEFAULT_ALGO_REGIME_CONFIG,
  type AlgoRegimeConfig,
} from "./algo-regime";
import type { CalibrationReport } from "./algo-regime-calibration";

export type RiskLevel = "conservative" | "balanced" | "aggressive";

export type AutoTuneResult = {
  suggested: AlgoRegimeConfig;
  changed: boolean;
  notes: string[];
};

/** Minimum matched observations before we're willing to nudge anything. */
export const MIN_SAMPLES_FOR_TUNING = 20;

type ClampSpec = {
  volBurstRatio:             { min: number; max: number; step: number };
  liquidityVacuumRatio:      { min: number; max: number; step: number };
  whipsawFlipsThreshold:     { min: number; max: number; step: number };
  correlationSpikeThreshold: { min: number; max: number; step: number };
  /** Max absolute deviation from DEFAULT_ALGO_REGIME_CONFIG allowed by tuning.
   *  Prevents cumulative drift that would invert the tier ladder. */
  maxDrift: {
    volBurstRatio: number;
    liquidityVacuumRatio: number;
    whipsawFlipsThreshold: number;
    correlationSpikeThreshold: number;
  };
};

/**
 * Per-risk-level clamps. Conservative tightens the whole envelope and shrinks
 * step size so tuning stays near defaults; aggressive widens both.
 *
 * Rationale: an aggressive book can absorb a slightly noisier detector for a
 * chance at higher sensitivity, whereas a conservative book prefers detection
 * to fail closed (fewer, higher-confidence flags) — hence the higher
 * volBurstRatio floor and smaller step.
 */
const CLAMPS_BY_RISK: Record<RiskLevel, ClampSpec> = {
  conservative: {
    volBurstRatio:             { min: 2.2, max: 3.6, step: 0.05 },
    liquidityVacuumRatio:      { min: 0.25, max: 0.55, step: 0.01 },
    whipsawFlipsThreshold:     { min: 8,   max: 18,  step: 1    },
    correlationSpikeThreshold: { min: 0.6, max: 0.85, step: 0.01 },
    maxDrift: {
      volBurstRatio: 0.4,
      liquidityVacuumRatio: 0.08,
      whipsawFlipsThreshold: 3,
      correlationSpikeThreshold: 0.08,
    },
  },
  balanced: {
    volBurstRatio:             { min: 1.8, max: 3.8, step: 0.1 },
    liquidityVacuumRatio:      { min: 0.22, max: 0.6, step: 0.02 },
    whipsawFlipsThreshold:     { min: 7,   max: 19,  step: 1   },
    correlationSpikeThreshold: { min: 0.55, max: 0.88, step: 0.02 },
    maxDrift: {
      volBurstRatio: 0.7,
      liquidityVacuumRatio: 0.14,
      whipsawFlipsThreshold: 5,
      correlationSpikeThreshold: 0.15,
    },
  },
  aggressive: {
    volBurstRatio:             { min: 1.5, max: 4.0, step: 0.15 },
    liquidityVacuumRatio:      { min: 0.2, max: 0.7, step: 0.03 },
    whipsawFlipsThreshold:     { min: 6,   max: 20,  step: 2    },
    correlationSpikeThreshold: { min: 0.5, max: 0.9, step: 0.03 },
    maxDrift: {
      volBurstRatio: 1.1,
      liquidityVacuumRatio: 0.22,
      whipsawFlipsThreshold: 8,
      correlationSpikeThreshold: 0.25,
    },
  },
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Clamp a candidate value to the risk-scaled hard bounds AND to a bounded
 * distance from the DEFAULT config. The drift cap is the ladder-inversion
 * guardrail: repeated nudges in the same direction across many auto-tune
 * cycles cannot compound past `maxDrift` and flip the tier semantics.
 */
function boundValue(
  key: "volBurstRatio" | "liquidityVacuumRatio" | "whipsawFlipsThreshold" | "correlationSpikeThreshold",
  candidate: number,
  clamps: ClampSpec,
): number {
  const spec = clamps[key];
  const drift = clamps.maxDrift[key];
  const def = DEFAULT_ALGO_REGIME_CONFIG[key];
  const driftLo = def - drift;
  const driftHi = def + drift;
  return clamp(candidate, Math.max(spec.min, driftLo), Math.min(spec.max, driftHi));
}

/**
 * Suggest a bounded update to `current` based on realised forward returns.
 *
 * Heuristics (all steps scaled by the risk level's ClampSpec):
 *   - Ladder is not monotone AND elevated is worse than extreme → the extreme
 *     bar is too strict; loosen (raise sensitivity) so more of what we're
 *     currently calling "elevated" escalates. LOWER `volBurstRatio` and
 *     RAISE `liquidityVacuumRatio`.
 *   - Extreme has < 3 observations while normal mean is negative → detector
 *     never fires when it should; make it slightly more sensitive.
 *   - Ladder monotone AND normal mean > 0 AND extreme has ≥ 10 obs with
 *     healthy separation → tighten one step so we stop over-flagging benign
 *     volatility.
 */
export function suggestConfigAdjustments(
  report: CalibrationReport,
  current: AlgoRegimeConfig = DEFAULT_ALGO_REGIME_CONFIG,
  riskLevel: RiskLevel = "balanced",
): AutoTuneResult {
  const notes: string[] = [];
  const next: AlgoRegimeConfig = { ...current };
  const clamps = CLAMPS_BY_RISK[riskLevel];

  if (report.matched < MIN_SAMPLES_FOR_TUNING) {
    notes.push(
      `insufficient sample (${report.matched} < ${MIN_SAMPLES_FOR_TUNING}) — no change`,
    );
    return { suggested: next, changed: false, notes };
  }

  const [n, e, x] = report.perTier;

  // Case 1: inverted ladder around the extreme rung.
  const invertedTop = e.count > 0 && x.count > 0 && e.meanReturn < x.meanReturn;
  if (invertedTop) {
    const before = { v: next.volBurstRatio, l: next.liquidityVacuumRatio };
    next.volBurstRatio = boundValue(
      "volBurstRatio",
      next.volBurstRatio - clamps.volBurstRatio.step,
      clamps,
    );
    next.liquidityVacuumRatio = boundValue(
      "liquidityVacuumRatio",
      next.liquidityVacuumRatio + clamps.liquidityVacuumRatio.step,
      clamps,
    );
    notes.push(
      `[${riskLevel}] inverted ladder (elevated ${(e.meanReturn * 100).toFixed(2)}% < extreme ${(x.meanReturn * 100).toFixed(2)}%): ` +
        `volBurstRatio ${before.v.toFixed(2)}→${next.volBurstRatio.toFixed(2)}, ` +
        `liquidityVacuumRatio ${before.l.toFixed(2)}→${next.liquidityVacuumRatio.toFixed(2)} (more sensitive)`,
    );
  }

  // Case 2: extreme never fires despite negative-mean normal days.
  if (!invertedTop && x.count < 3 && n.count > 0 && n.meanReturn < 0) {
    const before = next.volBurstRatio;
    next.volBurstRatio = boundValue(
      "volBurstRatio",
      next.volBurstRatio - clamps.volBurstRatio.step,
      clamps,
    );
    if (next.volBurstRatio !== before) {
      notes.push(
        `[${riskLevel}] extreme rarely fires (${x.count}) while normal mean ${(n.meanReturn * 100).toFixed(2)}% is negative: ` +
          `volBurstRatio ${before.toFixed(2)}→${next.volBurstRatio.toFixed(2)} (more sensitive)`,
      );
    }
  }

  // Case 3: healthy ladder — tighten one notch to reduce over-triggering.
  const healthy =
    !invertedTop &&
    report.monotone &&
    n.meanReturn > 0 &&
    x.count >= 10 &&
    n.meanReturn - x.meanReturn > 0.01; // >100bps forward-return separation
  if (healthy) {
    const before = next.volBurstRatio;
    next.volBurstRatio = boundValue(
      "volBurstRatio",
      next.volBurstRatio + clamps.volBurstRatio.step,
      clamps,
    );
    if (next.volBurstRatio !== before) {
      notes.push(
        `[${riskLevel}] healthy ladder (normal ${(n.meanReturn * 100).toFixed(2)}% vs extreme ${(x.meanReturn * 100).toFixed(2)}%): ` +
          `volBurstRatio ${before.toFixed(2)}→${next.volBurstRatio.toFixed(2)} (tighter, less over-triggering)`,
      );
    }
  }

  const changed = (Object.keys(next) as Array<keyof AlgoRegimeConfig>).some(
    (k) => next[k] !== current[k],
  );
  if (!changed && notes.length === 0) notes.push("no adjustment triggered");
  return { suggested: next, changed, notes };
}

/** Exposed for tests + UI diagnostics. */
export function getClampsForRisk(riskLevel: RiskLevel): ClampSpec {
  return CLAMPS_BY_RISK[riskLevel];
}
