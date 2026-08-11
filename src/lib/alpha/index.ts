export { scoreTrend } from "./trend";
export { scoreMeanReversion } from "./mean-reversion";
export { scoreQuality } from "./quality";
export { scoreCarry } from "./carry";
export { scoreBreakout, detectBreakout, breakoutSizeMultiplier, formatBreakoutBlock, DEFAULT_BREAKOUT_CONFIG } from "./breakout";
export type { BreakoutEvidence, BreakoutConfig, BreakoutState } from "./breakout";
export {
  breakoutRegimeAction,
  breakoutRegimeBucket,
  expectancyTableFromStats,
  DEFAULT_BREAKOUT_EXPECTANCY,
  DEFAULT_BREAKOUT_REGIME_POLICY,
} from "./breakout-regime-policy";
export type {
  BreakoutRegimeDecision,
  BreakoutExpectancyTable,
  BreakoutRegimeBucket,
  BreakoutCohortKey,
} from "./breakout-regime-policy";
export { scoreCandidate, scoreUniverse, scoreUniverseWithDiagnostics, formatAlphaPriorsForPrompt } from "./composite";
export { orthogonaliseScores, describeOrthogonalisation, DEFAULT_ORTHOGONALISATION } from "./orthogonalise";
export type { OrthogonalisationDiagnostic, OrthogonalisationPair } from "./orthogonalise";
export {
  walkForwardRegime,
  walkForwardAllRegimes,
  fitWeights,
  edgeOf,
  DEFAULT_WALK_FORWARD,
} from "./regime-walkforward";
export type {
  RegimeObservation,
  RegimeWalkForwardResult,
  WalkForwardConfig,
  RegimeVerdict,
} from "./regime-walkforward";
export { resolveRegime, weightsForRegime, effectiveWeightsForRegime, enabledStrategiesForRegime } from "./regime-matrix";
export type { AlphaScore, AlphaModelKind, CompositeScore, FeatureLike } from "./types";
export type { RegimeName, StrategyWeights } from "./regime-matrix";
export {
  breakoutAgeAction,
  ageBandFor,
  breakoutMinHoldBars,
  agePolicyFromRecommendation,
  DEFAULT_BREAKOUT_AGE_POLICY,
} from "./breakout-age-policy";
export type {
  BreakoutAgePolicy,
  BreakoutAgeBand,
  BreakoutAgeDecision,
} from "./breakout-age-policy";
export {
  computeModelMultipliers,
  applyAdaptiveWeights,
  describeAdaptiveWeights,
  multiplierFor,
  credibility,
  performanceSignal,
  type ModelPerformance,
  type ModelMultiplier,
  type AdaptiveWeightRow,
} from "./adaptive-weights";
