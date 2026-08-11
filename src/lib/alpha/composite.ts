// Regime-weighted composite scorer.
//
// For each candidate we run every model, then blend the resulting scores
// with the regime's strategy weights. The output is a bounded composite
// score in [-1, 1], the top-contributing model (by |weight × score|),
// and a compact rationale suitable for injection into the AI prompt.
import { scoreCarry } from "./carry";
import { scoreMeanReversion } from "./mean-reversion";
import { scoreQuality } from "./quality";
import { scoreTrend } from "./trend";
import { scoreBreakout } from "./breakout";
import { effectiveWeightsForRegime, type StrategyWeights } from "./regime-matrix";
import { clamp1, type AlphaModelKind, type AlphaScore, type CompositeScore, type FeatureLike } from "./types";

const MODELS: Array<(f: FeatureLike) => AlphaScore> = [
  scoreTrend, scoreMeanReversion, scoreQuality, scoreCarry, scoreBreakout,
];

export function scoreCandidate(
  f: FeatureLike,
  regime: string | null | undefined,
  weightsOverride?: StrategyWeights | null,
): CompositeScore {
  const weights = weightsOverride ?? effectiveWeightsForRegime(regime);
  const perModel: Partial<Record<AlphaModelKind, number>> = {};
  const rationales: Partial<Record<AlphaModelKind, string>> = {};
  let composite = 0;
  let topKind: AlphaModelKind | null = null;
  let topContribAbs = 0;

  for (const model of MODELS) {
    const s = model(f);
    perModel[s.kind] = s.score;
    rationales[s.kind] = s.reason;
    const contrib = weights[s.kind] * s.score;
    composite += contrib;
    if (Math.abs(contrib) > topContribAbs) {
      topContribAbs = Math.abs(contrib);
      topKind = s.kind;
    }
  }

  const reason = topKind
    ? `${topKind}(${(perModel[topKind] ?? 0).toFixed(2)}): ${rationales[topKind]}`
    : "no dominant driver";

  return {
    symbol: f.symbol,
    composite: clamp1(composite),
    perModel,
    top_driver: topKind,
    reason,
  };
}

export function scoreUniverse(
  features: FeatureLike[],
  regime: string | null | undefined,
  weightsOverride?: StrategyWeights | null,
): CompositeScore[] {
  return features.map((f) => scoreCandidate(f, regime, weightsOverride));
}

// Compact prompt block for the LLM adjudicator. Keeps only the top-N
// longs and top-N shorts so the prompt doesn't balloon.
export function formatAlphaPriorsForPrompt(
  scores: CompositeScore[],
  regime: string | null | undefined,
  topN = 10,
  weightsOverride?: StrategyWeights | null,
): string {
  const weights = weightsOverride ?? effectiveWeightsForRegime(regime);
  const sorted = [...scores].sort((a, b) => b.composite - a.composite);
  const longs = sorted.slice(0, topN).filter((s) => s.composite > 0.05);
  const avoids = sorted.slice(-topN).reverse().filter((s) => s.composite < -0.05);

  const weightsLine = (Object.entries(weights) as Array<[AlphaModelKind, number]>)
    .map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`)
    .join(" ");

  const long = longs.length
    ? longs.map((s) => `  ${s.symbol} ${s.composite.toFixed(2)} [${s.reason}]`).join("\n")
    : "  (none)";
  const avoid = avoids.length
    ? avoids.map((s) => `  ${s.symbol} ${s.composite.toFixed(2)} [${s.reason}]`).join("\n")
    : "  (none)";

  return [
    `ALPHA PRIORS (regime blend — ${weightsLine}):`,
    "Long-bias candidates:",
    long,
    "Avoid / short-bias candidates:",
    avoid,
    "Use these as priors, not commands — override when news, risk, or exits demand.",
  ].join("\n");
}
