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

import {
  DEFAULT_ALGO_REGIME_CONFIG,
  type AlgoRegimeConfig,
} from "./algo-regime";
import type { CalibrationReport } from "./algo-regime-calibration";

export type AutoTuneResult = {
  suggested: AlgoRegimeConfig;
  changed: boolean;
  notes: string[];
};

/** Minimum matched observations before we're willing to nudge anything. */
export const MIN_SAMPLES_FOR_TUNING = 20;

/** Hard clamps so a runaway tuner can never disable detection. */
const CLAMPS = {
  volBurstRatio:        { min: 1.5, max: 4.0, step: 0.1 },
  liquidityVacuumRatio: { min: 0.2, max: 0.7, step: 0.02 },
  whipsawFlipsThreshold:{ min: 6,   max: 20,  step: 1   },
  correlationSpikeThreshold: { min: 0.5, max: 0.9, step: 0.02 },
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Suggest a bounded update to `current` based on realised forward returns.
 *
 * Heuristics:
 *   - Ladder is not monotone AND elevated is worse than extreme → the extreme
 *     bar is too strict; loosen (raise sensitivity) so more of what we're
 *     currently calling "elevated" escalates. This means LOWERING
 *     `volBurstRatio` and RAISING `liquidityVacuumRatio`.
 *   - Extreme has < 3 observations while normal mean is negative → detector
 *     never fires when it should; make it slightly more sensitive.
 *   - Ladder monotone AND normal mean > 0 AND extreme has ≥ 10 obs with
 *     healthy separation → we can afford to tighten one step so we stop
 *     over-flagging benign volatility.
 */
export function suggestConfigAdjustments(
  report: CalibrationReport,
  current: AlgoRegimeConfig = DEFAULT_ALGO_REGIME_CONFIG,
): AutoTuneResult {
  const notes: string[] = [];
  const next: AlgoRegimeConfig = { ...current };

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
    next.volBurstRatio = clamp(
      next.volBurstRatio - CLAMPS.volBurstRatio.step,
      CLAMPS.volBurstRatio.min,
      CLAMPS.volBurstRatio.max,
    );
    next.liquidityVacuumRatio = clamp(
      next.liquidityVacuumRatio + CLAMPS.liquidityVacuumRatio.step,
      CLAMPS.liquidityVacuumRatio.min,
      CLAMPS.liquidityVacuumRatio.max,
    );
    notes.push(
      `inverted ladder (elevated ${(e.meanReturn * 100).toFixed(2)}% < extreme ${(x.meanReturn * 100).toFixed(2)}%): ` +
        `volBurstRatio ${before.v.toFixed(2)}→${next.volBurstRatio.toFixed(2)}, ` +
        `liquidityVacuumRatio ${before.l.toFixed(2)}→${next.liquidityVacuumRatio.toFixed(2)} (more sensitive)`,
    );
  }

  // Case 2: extreme never fires despite negative-mean normal days.
  if (!invertedTop && x.count < 3 && n.count > 0 && n.meanReturn < 0) {
    const before = next.volBurstRatio;
    next.volBurstRatio = clamp(
      next.volBurstRatio - CLAMPS.volBurstRatio.step,
      CLAMPS.volBurstRatio.min,
      CLAMPS.volBurstRatio.max,
    );
    if (next.volBurstRatio !== before) {
      notes.push(
        `extreme rarely fires (${x.count}) while normal mean ${(n.meanReturn * 100).toFixed(2)}% is negative: ` +
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
    next.volBurstRatio = clamp(
      next.volBurstRatio + CLAMPS.volBurstRatio.step,
      CLAMPS.volBurstRatio.min,
      CLAMPS.volBurstRatio.max,
    );
    if (next.volBurstRatio !== before) {
      notes.push(
        `healthy ladder (normal ${(n.meanReturn * 100).toFixed(2)}% vs extreme ${(x.meanReturn * 100).toFixed(2)}%): ` +
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
