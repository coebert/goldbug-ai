// Randomized execution model for Monte-Carlo backtesting.
//
// The deterministic backtests price every fill at the *expected* cost: the
// calibrated half-spread, the modelled impact, one commission ticket, and a
// clean 100% fill at the close. Live execution is not that tidy — the spread
// you actually cross varies bar to bar, thin opens and closes produce partial
// fills that either chase the tape or never complete, and the tail of the
// slippage distribution is much fatter than its mean.
//
// This module supplies seeded draws for those two effects so a strategy can be
// replayed hundreds of times to produce a *distribution* of outcomes instead
// of a single point estimate. Everything here is pure and deterministic given
// a seed, so Monte-Carlo results are reproducible and diffable.

/** Deterministic 32-bit PRNG (mulberry32). Same seed → same stream, forever. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller standard normal from a uniform stream. */
export function standardNormal(rng: () => number): number {
  // Clamp away from 0 so log() stays finite.
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type ExecutionSimConfig = {
  /**
   * Log-normal dispersion of the realised slippage multiplier. 0.5 means a
   * typical fill lands within roughly 0.6x–1.6x of the modelled slippage.
   */
  slippageSigma: number;
  /** Probability a fill hits a dislocated tape (gap, news, auction imbalance). */
  tailProb: number;
  /** Slippage multiplier applied on those tail fills, on top of the lognormal draw. */
  tailMult: number;
  /** Hard ceiling on the multiplier so one draw can't bankrupt a path. */
  maxSlippageMult: number;
  /** Probability an order completes in full on the bar it is sent. */
  fullFillProb: number;
  /** Smallest fraction of the requested size a partial fill delivers. */
  minFillRatio: number;
  /**
   * Probability an order is not filled at all on the bar (no liquidity at the
   * limit, venue rejection, suitability block). It can be retried next bar.
   */
  noFillProb: number;
};

export const DEFAULT_EXECUTION_SIM: ExecutionSimConfig = {
  slippageSigma: 0.5,
  tailProb: 0.02,
  tailMult: 4,
  maxSlippageMult: 12,
  fullFillProb: 0.85,
  minFillRatio: 0.25,
  noFillProb: 0.02,
};

export type ExecutionDraw = {
  /** Multiplier on the modelled spread + impact legs (commission is unaffected). */
  slippageMult: number;
  /** Fraction of requested size actually filled, 0…1. 0 means no fill this bar. */
  fillRatio: number;
};

/** A deterministic fill (multiplier 1, complete) — the point-estimate baseline. */
export const DETERMINISTIC_DRAW: ExecutionDraw = { slippageMult: 1, fillRatio: 1 };

export type ExecutionSampler = () => ExecutionDraw;

/**
 * Builds a seeded sampler. The multiplier is log-normal with unit *median*
 * (not unit mean) so the central case matches the calibrated model while the
 * right tail stays fat, which is how real slippage behaves.
 */
export function makeExecutionSampler(
  cfg: Partial<ExecutionSimConfig>,
  seed: number,
): ExecutionSampler {
  const c = { ...DEFAULT_EXECUTION_SIM, ...cfg };
  const rng = mulberry32(seed);
  return () => {
    let mult = Math.exp(standardNormal(rng) * c.slippageSigma);
    if (rng() < c.tailProb) mult *= c.tailMult;
    mult = Math.min(c.maxSlippageMult, Math.max(0, mult));

    let fillRatio = 1;
    const u = rng();
    if (u < c.noFillProb) fillRatio = 0;
    else if (u < c.noFillProb + (1 - c.fullFillProb - c.noFillProb)) {
      // Partial: uniform over [minFillRatio, 1).
      fillRatio = c.minFillRatio + rng() * (1 - c.minFillRatio);
    }
    return { slippageMult: mult, fillRatio };
  };
}

// ------------------------------------------------------------- statistics

export type PercentileStats = {
  n: number;
  mean: number;
  p5: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  worst: number;
  best: number;
  /** Mean of the worst 5% of paths — the expected shortfall. */
  cvar5: number;
  /** Fraction of paths that ended below zero. */
  probLoss: number;
  stdev: number;
};

/** Linear-interpolated percentile of an already-sorted ascending array. */
export function percentile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function percentileStats(values: readonly number[]): PercentileStats {
  const xs = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) {
    return {
      n: 0, mean: NaN, p5: NaN, p25: NaN, median: NaN, p75: NaN, p95: NaN,
      worst: NaN, best: NaN, cvar5: NaN, probLoss: NaN, stdev: NaN,
    };
  }
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const tailCount = Math.max(1, Math.floor(n * 0.05));
  const cvar5 = xs.slice(0, tailCount).reduce((a, b) => a + b, 0) / tailCount;
  return {
    n,
    mean,
    p5: percentile(xs, 0.05),
    p25: percentile(xs, 0.25),
    median: percentile(xs, 0.5),
    p75: percentile(xs, 0.75),
    p95: percentile(xs, 0.95),
    worst: xs[0]!,
    best: xs[n - 1]!,
    cvar5,
    probLoss: xs.filter((v) => v < 0).length / n,
    stdev: Math.sqrt(variance),
  };
}
