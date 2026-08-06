// One coordinated verdict from the three systematic scorers.
//
// Previously `alpha/composite` (regime-blended factor score),
// `cross-sectional-ranking` (peer z-score rank) and `ensemble.server`
// (trend/RSI/momentum vote) each re-voted on the same raw features with
// their own hand-set weights, and each applied its own independent
// haircut to the ticket. That triple-counts the same information and
// compounds into tiny trades.
//
// This module blends them once, with weights declared in a single place,
// into a signed score in [-1, 1] plus a single size multiplier.

export const SCORER_WEIGHTS = {
  /** Regime-blended factor composite (trend/mean-rev/quality/carry). */
  alpha: 0.45,
  /** Cross-sectional rank versus today's universe. */
  crossSectional: 0.35,
  /** Deterministic trend/RSI/momentum second opinion. */
  ensemble: 0.2,
} as const;

/** Combined disagreement below this fraction of full severity is ignored. */
const AGREE_BAND = 0.15;
/** Worst multiplier a fully-opposed systematic stack can impose. */
const MIN_SIGNAL_MULT = 0.45;

export type UnifiedScorerInput = {
  side: "buy" | "sell";
  /** Composite alpha score in [-1, 1], or null when unavailable. */
  alphaComposite: number | null | undefined;
  /** Cross-sectional percentile in [0, 1] (1 = strongest), or null. */
  rankPercentile: number | null | undefined;
  /** Ensemble vote score in [-1, 1], or null. */
  ensembleScore: number | null | undefined;
};

export type UnifiedScore = {
  /** Blended score in [-1, 1], positive = long-favouring. */
  score: number;
  /** Signed agreement with the proposed side in [-1, 1]. */
  agreement: number;
  /** Single size multiplier in [MIN_SIGNAL_MULT, 1]. */
  mult: number;
  /** Contributions actually available this run. */
  used: Array<keyof typeof SCORER_WEIGHTS>;
  /** Sizing note, or null when the stack is neutral/supportive. */
  note: string | null;
};

const clamp1 = (n: number) => Math.max(-1, Math.min(1, n));

/**
 * Blend the three systematic scorers into one verdict.
 *
 * Missing inputs are dropped and the remaining weights renormalised, so
 * a run without cross-sectional ranks still produces a usable score
 * rather than silently biasing toward zero.
 */
export function unifiedScore(input: UnifiedScorerInput): UnifiedScore {
  const parts: Array<{ key: keyof typeof SCORER_WEIGHTS; value: number }> = [];

  // `Number(null)` is 0, so nullish inputs must be rejected explicitly —
  // otherwise a missing scorer votes "neutral" and dilutes the blend.
  const present = (v: number | null | undefined): v is number =>
    v != null && Number.isFinite(Number(v));

  if (present(input.alphaComposite)) {
    parts.push({ key: "alpha", value: clamp1(Number(input.alphaComposite)) });
  }
  // Percentile 0..1 maps to -1..+1 so the median name is neutral.
  if (present(input.rankPercentile)) {
    parts.push({ key: "crossSectional", value: clamp1(Number(input.rankPercentile) * 2 - 1) });
  }
  if (present(input.ensembleScore)) {
    parts.push({ key: "ensemble", value: clamp1(Number(input.ensembleScore)) });
  }

  if (parts.length === 0) {
    return { score: 0, agreement: 0, mult: 1, used: [], note: null };
  }

  const totalWeight = parts.reduce((s, p) => s + SCORER_WEIGHTS[p.key], 0);
  const score = clamp1(
    parts.reduce((s, p) => s + (SCORER_WEIGHTS[p.key] / totalWeight) * p.value, 0),
  );

  const sideSign = input.side === "buy" ? 1 : -1;
  const agreement = clamp1(score * sideSign);

  // Only disagreement shrinks size; agreement is rewarded elsewhere by
  // the alpha×conviction bonus, so it must not double-count here.
  if (agreement >= -AGREE_BAND) {
    return { score, agreement, mult: 1, used: parts.map((p) => p.key), note: null };
  }

  const severity = Math.min(1, (-agreement - AGREE_BAND) / (1 - AGREE_BAND));
  const mult = 1 - (1 - MIN_SIGNAL_MULT) * severity;
  return {
    score,
    agreement,
    mult,
    used: parts.map((p) => p.key),
    note: `systematic≠${input.side} (blend ${score.toFixed(2)}) ×${mult.toFixed(2)}`,
  };
}
