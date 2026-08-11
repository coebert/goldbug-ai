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

// ------------------------------------------------- drawdown breach analysis

export type DrawdownBreach = {
  /** Threshold as a positive percentage depth, e.g. 10 means "a 10% drawdown". */
  thresholdPct: number;
  /** Fraction of paths whose worst drawdown reached at least that depth. */
  prob: number;
  /** Number of paths that breached. */
  count: number;
};

/**
 * Probability that a path's deepest drawdown breaches each threshold.
 * `drawdownsPct` are negative percentages (-12.4 = a 12.4% drawdown);
 * thresholds are given as positive depths and may be passed in any order.
 * Non-finite paths are ignored, matching `percentileStats`.
 */
export function drawdownBreachProbabilities(
  drawdownsPct: readonly number[],
  thresholdsPct: readonly number[],
): DrawdownBreach[] {
  const xs = drawdownsPct.filter((v) => Number.isFinite(v));
  const n = xs.length;
  return [...thresholdsPct]
    .map((t) => Math.abs(t))
    .sort((a, b) => a - b)
    .map((thresholdPct) => {
      const count = xs.filter((v) => -v >= thresholdPct - 1e-12).length;
      return { thresholdPct, prob: n ? count / n : NaN, count };
    });
}

export const DEFAULT_DRAWDOWN_THRESHOLDS = [5, 10, 15, 20, 25, 30] as const;

// ------------------------------------------------- joint (stress) tail stats
//
// A drawdown that happens on a calm tape is a signal problem; the same depth
// reached while every symbol is gapping and half the exits will not fill is an
// execution problem you cannot trade out of. These helpers separate the two.

export type JointDrawdownBreach = DrawdownBreach & {
  /** P(deepest drawdown breaches AND the breach happened in a stress regime). */
  jointProb: number;
  /** Paths that breached inside stress. */
  jointCount: number;
  /** P(the breach was in stress | it breached) — how "execution-driven" the tail is. */
  probStressGivenBreach: number;
};

/**
 * Breach probabilities split by whether the breach occurred while the market
 * was in the correlated stress regime. `inStress[i]` describes path `i`'s
 * deepest drawdown (typically: the trough bar, or its peak→trough window,
 * overlapped a stressed bar). Lengths must match; extra entries are ignored.
 */
export function jointDrawdownBreachProbabilities(
  drawdownsPct: readonly number[],
  inStress: readonly boolean[],
  thresholdsPct: readonly number[],
): JointDrawdownBreach[] {
  const rows = drawdownsPct
    .map((v, i) => ({ v, stressed: inStress[i] === true }))
    .filter((r) => Number.isFinite(r.v));
  const n = rows.length;
  return [...thresholdsPct]
    .map((t) => Math.abs(t))
    .sort((a, b) => a - b)
    .map((thresholdPct) => {
      const breached = rows.filter((r) => -r.v >= thresholdPct - 1e-12);
      const joint = breached.filter((r) => r.stressed);
      return {
        thresholdPct,
        prob: n ? breached.length / n : NaN,
        count: breached.length,
        jointProb: n ? joint.length / n : NaN,
        jointCount: joint.length,
        probStressGivenBreach: breached.length ? joint.length / breached.length : NaN,
      };
    });
}

export type ConditionalTailStats = {
  /** Paths kept by the condition. */
  count: number;
  /** Share of all finite paths kept. */
  share: number;
  /** Exposure cut-off used to select the subset (the quantile value). */
  cutoff: number;
  mean: number;
  median: number;
  worst: number;
  /** Mean of the worst `tailFrac` of the *conditioned* subset. */
  cvar: number;
};

/**
 * Conditional tail statistics on the worst-stress paths: keep the paths whose
 * `exposure` (e.g. share of execution cost paid in stress, or share of bars
 * stressed) sits at or above the `quantile` of the exposure distribution, then
 * report the tail of `values` (returns or drawdowns) *within that subset*.
 *
 * This is the "conditional CVaR on the worst-stress regime" number: not the
 * unconditional 1-in-20 path, but the average bad outcome given the tape was
 * one of the ugly ones.
 */
export function conditionalTailStats(
  values: readonly number[],
  exposure: readonly number[],
  quantile = 0.8,
  tailFrac = 0.2,
): ConditionalTailStats {
  const rows = values
    .map((v, i) => ({ v, e: exposure[i] ?? NaN }))
    .filter((r) => Number.isFinite(r.v) && Number.isFinite(r.e));
  const empty: ConditionalTailStats = {
    count: 0, share: 0, cutoff: NaN, mean: NaN, median: NaN, worst: NaN, cvar: NaN,
  };
  if (!rows.length) return empty;
  const sortedExposure = rows.map((r) => r.e).sort((a, b) => a - b);
  const cutoff = percentile(sortedExposure, Math.min(1, Math.max(0, quantile)));
  let subset = rows.filter((r) => r.e >= cutoff - 1e-12);
  // Degenerate exposure (all equal, or a cut-off above every value) must still
  // yield a usable tail rather than an empty one.
  if (!subset.length) subset = rows;
  const vals = subset.map((r) => r.v).sort((a, b) => a - b);
  const k = Math.max(1, Math.round(vals.length * Math.min(1, Math.max(0, tailFrac))));
  const tail = vals.slice(0, k);
  return {
    count: subset.length,
    share: subset.length / rows.length,
    cutoff,
    mean: subset.reduce((a, r) => a + r.v, 0) / subset.length,
    median: percentile(vals, 0.5),
    worst: vals[0]!,
    cvar: tail.reduce((a, b) => a + b, 0) / tail.length,
  };
}

