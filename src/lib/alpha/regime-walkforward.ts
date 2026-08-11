// Phase 3 item 17 — walk-forward validation of the regime → weight matrix.
//
// The matrix in regime-matrix.ts is a hand-set prior. This module asks the
// tape whether a *fitted* weight vector would have beaten that prior out of
// sample, regime by regime, and refuses to recommend a change unless the
// evidence survives repeated forward folds.
//
// Method, per regime:
//   1. Split that regime's observations chronologically into rolling
//      train/test folds (expanding is avoided on purpose — a fixed train
//      window keeps the fit honest about regime drift).
//   2. On each train slice, fit weights from the covariance between each
//      model's score and the forward return: w_k ∝ max(0, cov_k), then shrink
//      toward the prior by a credibility factor and renormalise.
//   3. Score both weight vectors on the untouched test slice as the mean
//      forward return earned by the composite's sign, in bps.
//   4. Aggregate: fitted only wins if it beats the prior on average AND in a
//      majority of folds AND the sample count clears the floor.
//
// Everything here is pure — callers supply observations and receive a
// recommendation; persistence and scheduling live elsewhere.
import type { AlphaModelKind } from "./types";
import type { StrategyWeights } from "./regime-matrix";

const KINDS: AlphaModelKind[] = ["trend", "mean_reversion", "quality", "carry", "breakout"];

export type RegimeObservation = {
  /** Sortable timestamp (ISO date or datetime). */
  ts: string;
  /** Regime label active when the scores were generated. */
  regime: string;
  /** Per-model scores in [-1, 1] for one symbol on one tick. */
  perModel: Partial<Record<AlphaModelKind, number>>;
  /** Realised forward return over the evaluation horizon, in bps. */
  forwardBps: number;
};

export type WalkForwardConfig = {
  /** Observations per training slice. */
  trainSize: number;
  /** Observations per test slice. */
  testSize: number;
  /** How far the window advances between folds. */
  step: number;
  /** Minimum total observations for a regime to be evaluated at all. */
  minSamples: number;
  /** Shrinkage toward the prior at full credibility, 0..1 (0 = pure fit). */
  priorShrink: number;
  /** Fitted must beat prior by at least this many bps on average. */
  minEdgeGainBps: number;
  /** Fraction of folds the fitted vector must win. */
  minWinRate: number;
};

export const DEFAULT_WALK_FORWARD: WalkForwardConfig = {
  trainSize: 250,
  testSize: 60,
  step: 60,
  minSamples: 400,
  priorShrink: 0.5,
  minEdgeGainBps: 3,
  minWinRate: 0.6,
};

export type FoldResult = {
  index: number;
  trainFrom: string;
  testFrom: string;
  testTo: string;
  testSamples: number;
  priorEdgeBps: number;
  fittedEdgeBps: number;
  fittedWeights: StrategyWeights;
};

export type RegimeVerdict = "supported" | "not_supported" | "insufficient_data";

export type RegimeWalkForwardResult = {
  regime: string;
  samples: number;
  folds: FoldResult[];
  priorWeights: StrategyWeights;
  /** Weights fitted on ALL observations, shrunk toward the prior. */
  recommendedWeights: StrategyWeights;
  meanPriorEdgeBps: number;
  meanFittedEdgeBps: number;
  edgeGainBps: number;
  foldWinRate: number;
  verdict: RegimeVerdict;
  summary: string;
};

const zeroWeights = (): StrategyWeights =>
  ({ trend: 0, mean_reversion: 0, quality: 0, carry: 0, breakout: 0 });

function normalise(w: StrategyWeights, fallback: StrategyWeights): StrategyWeights {
  const total = KINDS.reduce((a, k) => a + Math.max(0, w[k]), 0);
  if (!(total > 0)) return { ...fallback };
  const out = zeroWeights();
  for (const k of KINDS) out[k] = Math.max(0, w[k]) / total;
  return out;
}

function composite(scores: Partial<Record<AlphaModelKind, number>>, w: StrategyWeights): number {
  let s = 0;
  for (const k of KINDS) s += (Number(scores[k] ?? 0) || 0) * w[k];
  return s;
}

/**
 * Mean forward return, in bps, earned by taking the sign of the composite.
 * Zero-composite observations are skipped rather than counted as flat, so a
 * weight vector is not rewarded for abstaining.
 */
export function edgeOf(obs: RegimeObservation[], w: StrategyWeights): number {
  let sum = 0;
  let n = 0;
  for (const o of obs) {
    const c = composite(o.perModel, w);
    if (Math.abs(c) < 1e-9) continue;
    sum += Math.sign(c) * o.forwardBps;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Fit weights from score↔return covariance, keep only positive covariance
 * (a model that predicts backwards gets zero, not a negative weight — the
 * composite already handles direction through the score's own sign), then
 * shrink toward the prior by sample credibility.
 */
export function fitWeights(
  obs: RegimeObservation[],
  prior: StrategyWeights,
  cfg: Pick<WalkForwardConfig, "priorShrink"> = DEFAULT_WALK_FORWARD,
): StrategyWeights {
  if (obs.length < 2) return { ...prior };
  const meanRet = obs.reduce((a, o) => a + o.forwardBps, 0) / obs.length;
  const raw = zeroWeights();
  for (const k of KINDS) {
    // Models the prior switched off stay off — fitting never re-enables a
    // strategy the regime matrix deliberately disabled.
    if (prior[k] <= 0) continue;
    const xs = obs.map((o) => Number(o.perModel[k] ?? 0) || 0);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    let cov = 0;
    for (let i = 0; i < obs.length; i += 1) cov += (xs[i]! - mx) * (obs[i]!.forwardBps - meanRet);
    cov /= obs.length - 1;
    raw[k] = Math.max(0, cov);
  }
  const fitted = normalise(raw, prior);
  const shrink = Math.max(0, Math.min(1, cfg.priorShrink));
  const blended = zeroWeights();
  for (const k of KINDS) blended[k] = fitted[k] * (1 - shrink) + prior[k] * shrink;
  return normalise(blended, prior);
}

/**
 * Rolling train/test evaluation for one regime's observations.
 * Observations are sorted chronologically before folding.
 */
export function walkForwardRegime(
  regime: string,
  observations: RegimeObservation[],
  prior: StrategyWeights,
  cfg: WalkForwardConfig = DEFAULT_WALK_FORWARD,
): RegimeWalkForwardResult {
  const obs = [...observations].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const base: Omit<RegimeWalkForwardResult, "verdict" | "summary"> = {
    regime,
    samples: obs.length,
    folds: [],
    priorWeights: { ...prior },
    recommendedWeights: { ...prior },
    meanPriorEdgeBps: 0,
    meanFittedEdgeBps: 0,
    edgeGainBps: 0,
    foldWinRate: 0,
  };

  if (obs.length < cfg.minSamples || obs.length < cfg.trainSize + cfg.testSize) {
    return {
      ...base,
      verdict: "insufficient_data",
      summary: `${regime}: ${obs.length} observations — need ${Math.max(cfg.minSamples, cfg.trainSize + cfg.testSize)}; keeping the prior`,
    };
  }

  const folds: FoldResult[] = [];
  let index = 0;
  for (let start = 0; start + cfg.trainSize + cfg.testSize <= obs.length; start += cfg.step) {
    const train = obs.slice(start, start + cfg.trainSize);
    const test = obs.slice(start + cfg.trainSize, start + cfg.trainSize + cfg.testSize);
    const fitted = fitWeights(train, prior, cfg);
    folds.push({
      index: index++,
      trainFrom: train[0]!.ts,
      testFrom: test[0]!.ts,
      testTo: test[test.length - 1]!.ts,
      testSamples: test.length,
      priorEdgeBps: edgeOf(test, prior),
      fittedEdgeBps: edgeOf(test, fitted),
      fittedWeights: fitted,
    });
  }

  if (folds.length === 0) {
    return { ...base, verdict: "insufficient_data", summary: `${regime}: no complete folds; keeping the prior` };
  }

  const meanPrior = folds.reduce((a, f) => a + f.priorEdgeBps, 0) / folds.length;
  const meanFitted = folds.reduce((a, f) => a + f.fittedEdgeBps, 0) / folds.length;
  const wins = folds.filter((f) => f.fittedEdgeBps > f.priorEdgeBps).length;
  const winRate = wins / folds.length;
  const gain = meanFitted - meanPrior;

  const supported = gain >= cfg.minEdgeGainBps && winRate >= cfg.minWinRate;
  const recommended = supported ? fitWeights(obs, prior, cfg) : { ...prior };

  return {
    regime,
    samples: obs.length,
    folds,
    priorWeights: { ...prior },
    recommendedWeights: recommended,
    meanPriorEdgeBps: meanPrior,
    meanFittedEdgeBps: meanFitted,
    edgeGainBps: gain,
    foldWinRate: winRate,
    verdict: supported ? "supported" : "not_supported",
    summary: supported
      ? `${regime}: fitted weights add ${gain.toFixed(1)}bps/trade across ${folds.length} folds (won ${wins}/${folds.length}) — recommend adopting`
      : `${regime}: fitted weights add ${gain.toFixed(1)}bps (won ${wins}/${folds.length}) — below the bar, keep the prior`,
  };
}

/** Group observations by regime and walk-forward each one independently. */
export function walkForwardAllRegimes(
  observations: RegimeObservation[],
  priors: Record<string, StrategyWeights>,
  cfg: WalkForwardConfig = DEFAULT_WALK_FORWARD,
): RegimeWalkForwardResult[] {
  const byRegime = new Map<string, RegimeObservation[]>();
  for (const o of observations) {
    const key = String(o.regime || "unknown");
    const list = byRegime.get(key);
    if (list) list.push(o);
    else byRegime.set(key, [o]);
  }
  return [...byRegime.entries()]
    .map(([regime, obs]) => walkForwardRegime(regime, obs, priors[regime] ?? priors["unknown"] ?? zeroWeights(), cfg))
    .sort((a, b) => b.samples - a.samples);
}
