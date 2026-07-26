export { scoreTrend } from "./trend";
export { scoreMeanReversion } from "./mean-reversion";
export { scoreQuality } from "./quality";
export { scoreCarry } from "./carry";
export { scoreCandidate, scoreUniverse, formatAlphaPriorsForPrompt } from "./composite";
export { resolveRegime, weightsForRegime, effectiveWeightsForRegime, enabledStrategiesForRegime } from "./regime-matrix";
export type { AlphaScore, AlphaModelKind, CompositeScore, FeatureLike } from "./types";
export type { RegimeName, StrategyWeights } from "./regime-matrix";
