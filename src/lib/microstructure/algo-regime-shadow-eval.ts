// Phase H — Shadow evaluation. Pure decision function that compares the
// pre-tune (baseline) calibration report against the post-tune (shadow)
// calibration report and decides whether to KEEP the new config, ROLL BACK
// to the previous one, or WAIT for more samples.
//
// I/O free — safe to import from anywhere and trivial to unit-test.

import type { CalibrationReport } from "./algo-regime-calibration";

export type ShadowAction = "keep" | "rollback" | "wait";

export type ShadowDecision = {
  action: ShadowAction;
  reason: string;
  /** Post-tune minus baseline mean (fraction) for the "normal" tier. */
  normalMeanDelta: number | null;
  /** Post-tune minus baseline mean (fraction) for the "extreme" tier. */
  extremeMeanDelta: number | null;
};

export type ShadowEvalOptions = {
  /** Minimum post-tune matched observations before deciding anything. */
  minPostSamples: number;
  /**
   * Regression tolerance on the "normal" tier's mean forward return
   * (fraction). If post-tune normal mean drops by more than this vs
   * baseline, we roll back. Default 50 bps.
   */
  normalMeanRegressionTolerance: number;
  /**
   * If baseline was monotone but post-tune is not AND the extreme tier
   * had at least this many post-tune observations, roll back.
   */
  minExtremeSamplesForMonotoneCheck: number;
};

export const DEFAULT_SHADOW_EVAL_OPTIONS: ShadowEvalOptions = {
  minPostSamples: 10,
  normalMeanRegressionTolerance: 0.005,
  minExtremeSamplesForMonotoneCheck: 3,
};

function meanOf(report: CalibrationReport, tier: "normal" | "extreme"): number | null {
  const row = report.perTier.find((t) => t.tier === tier);
  return row && row.count > 0 ? row.meanReturn : null;
}

/**
 * Decide whether to keep the newly-applied config or roll back to the
 * previous one, based on realised forward-return statistics inside the
 * post-tune shadow window.
 *
 * Rules (evaluated in order — first match wins):
 *   1. WAIT if we haven't collected enough post-tune samples yet.
 *   2. ROLLBACK if the ladder was monotone before but is now inverted
 *      AND we have enough extreme-tier samples to trust the flip.
 *   3. ROLLBACK if the "normal" tier's mean forward return regressed by
 *      more than `normalMeanRegressionTolerance` — the guard was letting
 *      us take good trades before and is now blocking them.
 *   4. KEEP otherwise.
 */
export function evaluateShadow(
  baseline: CalibrationReport,
  post: CalibrationReport,
  opts: ShadowEvalOptions = DEFAULT_SHADOW_EVAL_OPTIONS,
): ShadowDecision {
  const bNormal = meanOf(baseline, "normal");
  const pNormal = meanOf(post, "normal");
  const bExtreme = meanOf(baseline, "extreme");
  const pExtreme = meanOf(post, "extreme");

  const normalMeanDelta =
    bNormal !== null && pNormal !== null ? pNormal - bNormal : null;
  const extremeMeanDelta =
    bExtreme !== null && pExtreme !== null ? pExtreme - bExtreme : null;

  if (post.matched < opts.minPostSamples) {
    return {
      action: "wait",
      reason: `only ${post.matched} post-tune samples (need ${opts.minPostSamples})`,
      normalMeanDelta,
      extremeMeanDelta,
    };
  }

  const postExtremeCount =
    post.perTier.find((t) => t.tier === "extreme")?.count ?? 0;
  if (
    baseline.monotone &&
    !post.monotone &&
    postExtremeCount >= opts.minExtremeSamplesForMonotoneCheck
  ) {
    return {
      action: "rollback",
      reason: `ladder inverted after tune (baseline monotone, post non-monotone; extreme n=${postExtremeCount})`,
      normalMeanDelta,
      extremeMeanDelta,
    };
  }

  if (
    normalMeanDelta !== null &&
    normalMeanDelta < -opts.normalMeanRegressionTolerance
  ) {
    return {
      action: "rollback",
      reason:
        `normal-tier mean regressed by ${(-normalMeanDelta * 100).toFixed(2)}% ` +
        `(> tolerance ${(opts.normalMeanRegressionTolerance * 100).toFixed(2)}%)`,
      normalMeanDelta,
      extremeMeanDelta,
    };
  }

  return {
    action: "keep",
    reason:
      `post-tune healthy: matched=${post.matched}` +
      (normalMeanDelta !== null
        ? `, normal Δ ${(normalMeanDelta * 100).toFixed(2)}%`
        : ""),
    normalMeanDelta,
    extremeMeanDelta,
  };
}
