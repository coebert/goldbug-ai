// Pure summary of what the thesis-break exit layer did to a replay: the two
// numbers that matter for "did it protect me" — max drawdown and average
// losing trade — plus the return it cost to get them.

import type { ArmResult, FiringSplit } from "./thesis-break-replay";

export type ThesisBreakImpact = {
  /** Stop-only arm (layer off). */
  base: { maxDrawdownPct: number; avgLossPct: number; totalReturnPct: number };
  /** Same tape with the thesis-break layer on. */
  withLayer: { maxDrawdownPct: number; avgLossPct: number; totalReturnPct: number };
  /** Negative = shallower drawdown with the layer on (an improvement). */
  drawdownDeltaPp: number;
  /** Positive = smaller average loss with the layer on (an improvement). */
  avgLossDeltaPp: number;
  /** Return given up (negative) or gained (positive) by running the layer. */
  returnDeltaPp: number;
  actions: { trim: number; close: number; total: number };
  firstLossFireRatePct: number;
  repeatFireRatePct: number;
  verdict: "protective" | "protective_but_costly" | "no_effect" | "harmful";
};

const round = (v: number) => Number((Number.isFinite(v) ? v : 0).toFixed(2));

export function computeThesisBreakImpact(
  base: ArmResult,
  withLayer: ArmResult,
  firing?: FiringSplit,
): ThesisBreakImpact {
  const drawdownDeltaPp = round(withLayer.maxDrawdownPct - base.maxDrawdownPct);
  const avgLossDeltaPp = round(withLayer.avgLossPct - base.avgLossPct);
  const returnDeltaPp = round(withLayer.totalReturnPct - base.totalReturnPct);
  const actions = {
    trim: withLayer.actionMix.trim,
    close: withLayer.actionMix.close,
    total: withLayer.thesisEvents.length,
  };

  // Drawdown is reported as a negative-going magnitude in the replay, so a
  // shallower drawdown means a smaller magnitude; normalise on magnitude.
  const ddImproved = Math.abs(withLayer.maxDrawdownPct) < Math.abs(base.maxDrawdownPct) - 0.1;
  const ddWorse = Math.abs(withLayer.maxDrawdownPct) > Math.abs(base.maxDrawdownPct) + 0.1;
  const lossImproved = Math.abs(withLayer.avgLossPct) < Math.abs(base.avgLossPct) - 0.1;
  const lossWorse = Math.abs(withLayer.avgLossPct) > Math.abs(base.avgLossPct) + 0.1;

  let verdict: ThesisBreakImpact["verdict"];
  if (actions.total === 0 || (!ddImproved && !ddWorse && !lossImproved && !lossWorse)) {
    verdict = "no_effect";
  } else if (ddImproved || lossImproved) {
    verdict = returnDeltaPp < -0.5 ? "protective_but_costly" : "protective";
  } else {
    verdict = "harmful";
  }

  return {
    base: {
      maxDrawdownPct: round(base.maxDrawdownPct),
      avgLossPct: round(base.avgLossPct),
      totalReturnPct: round(base.totalReturnPct),
    },
    withLayer: {
      maxDrawdownPct: round(withLayer.maxDrawdownPct),
      avgLossPct: round(withLayer.avgLossPct),
      totalReturnPct: round(withLayer.totalReturnPct),
    },
    drawdownDeltaPp,
    avgLossDeltaPp,
    returnDeltaPp,
    actions,
    firstLossFireRatePct: round(firing?.firstLossFireRatePct ?? 0),
    repeatFireRatePct: round(firing?.repeatFireRatePct ?? 0),
    verdict,
  };
}
