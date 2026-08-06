// Statistical significance testing for walk-forward results.
//
// A walk-forward run hands back a handful of out-of-sample folds. The headline
// "+4% CAGR versus the benchmark" is a sample mean over maybe 6 numbers — it
// can easily be noise. This module answers one question in several
// complementary ways: is the CAGR edge real, or is it what you'd expect from
// chance?
//
//   - Paired t-test on per-fold CAGR differences (parametric, needs roughly
//     symmetric folds).
//   - Exact sign test (non-parametric, immune to one monster fold).
//   - Sign-flip permutation test (exhaustive up to 20 folds, deterministic
//     pseudo-random beyond that) — no distributional assumption at all.
//   - A multiple-testing correction, because searching N parameter sets and
//     reporting the winner inflates significance.
//
// Pure and deterministic: same folds in, same p-values out.

import type { FoldOutcome, WalkForwardSummary } from "./walk-forward";

// ---------------------------------------------------------------------------
// Distribution helpers
// ---------------------------------------------------------------------------

function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j]! / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued-fraction evaluation of the incomplete beta (Numerical Recipes). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for a Student-t statistic with `df` degrees of freedom. */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  const x = df / (df + t * t);
  return Math.min(1, Math.max(0, incompleteBeta(df / 2, 0.5, x)));
}

/** Two-sided critical t value at the given alpha, by bisection on the p-value. */
export function tCritical(df: number, alpha = 0.05): number {
  if (df <= 0) return Number.POSITIVE_INFINITY;
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTTwoSidedP(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Exact two-sided binomial p-value for `k` successes in `n` fair trials. */
export function binomialTwoSidedP(k: number, n: number, p = 0.5): number {
  if (n <= 0) return 1;
  const pmf = (i: number) => Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  const target = pmf(k) * (1 + 1e-9);
  let total = 0;
  for (let i = 0; i <= n; i++) {
    const v = pmf(i);
    if (v <= target) total += v;
  }
  return Math.min(1, total);
}

// ---------------------------------------------------------------------------
// Core tests
// ---------------------------------------------------------------------------

export type TTestResult = {
  n: number;
  meanDiff: number;
  stdDev: number;
  /** Standard error of the mean difference. */
  stderr: number;
  t: number;
  df: number;
  pValue: number;
  /** Cohen's d (mean / sd) — magnitude, independent of sample size. */
  effectSize: number;
  /** Two-sided confidence interval on the mean difference. */
  ci: [number, number];
  alpha: number;
  significant: boolean;
};

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function sampleStdDev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1));
}

/**
 * One-sample t-test of `diffs` against zero. Feed it per-fold CAGR differences
 * (strategy − benchmark) for a paired test, or raw fold CAGRs to ask "is the
 * edge above zero at all?".
 */
export function pairedTTest(diffs: readonly number[], alpha = 0.05): TTestResult {
  const n = diffs.length;
  const m = mean(diffs);
  const sd = sampleStdDev(diffs);
  const df = Math.max(0, n - 1);
  const stderr = n > 0 ? sd / Math.sqrt(n) : 0;
  const t = stderr > 0 ? m / stderr : 0;
  const pValue = n < 2 ? 1 : stderr > 0 ? studentTTwoSidedP(t, df) : m === 0 ? 1 : 0;
  const crit = n < 2 ? Number.POSITIVE_INFINITY : tCritical(df, alpha);
  const half = Number.isFinite(crit) ? crit * stderr : Number.POSITIVE_INFINITY;
  return {
    n,
    meanDiff: m,
    stdDev: sd,
    stderr,
    t,
    df,
    pValue,
    effectSize: sd > 0 ? m / sd : 0,
    ci: [m - half, m + half],
    alpha,
    significant: pValue < alpha && m > 0,
  };
}

export type SignTestResult = {
  n: number;
  positives: number;
  negatives: number;
  ties: number;
  pValue: number;
  significant: boolean;
};

/** Exact sign test — how surprising is this many winning folds under a coin flip? */
export function signTest(diffs: readonly number[], alpha = 0.05): SignTestResult {
  const positives = diffs.filter((d) => d > 0).length;
  const negatives = diffs.filter((d) => d < 0).length;
  const ties = diffs.length - positives - negatives;
  const n = positives + negatives;
  const pValue = n === 0 ? 1 : binomialTwoSidedP(positives, n);
  return { n, positives, negatives, ties, pValue, significant: pValue < alpha && positives > negatives };
}

export type PermutationResult = {
  n: number;
  observedMean: number;
  /** Permutations actually evaluated. */
  permutations: number;
  exhaustive: boolean;
  /** Share of sign-flipped resamples whose |mean| reaches the observed one. */
  pValue: number;
  significant: boolean;
};

/** Deterministic 32-bit LCG — reproducible resampling without a global RNG. */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const MAX_EXHAUSTIVE_FOLDS = 20;

/**
 * Sign-flip permutation test. Under the null "the fold differences are just
 * noise around zero", flipping each fold's sign is equally likely, so the
 * distribution of resampled means is the null distribution.
 */
export function signFlipPermutationTest(
  diffs: readonly number[],
  opts: { alpha?: number; iterations?: number; seed?: number } = {},
): PermutationResult {
  const alpha = opts.alpha ?? 0.05;
  const n = diffs.length;
  const observedMean = mean(diffs);
  if (n < 2) {
    return { n, observedMean, permutations: 0, exhaustive: false, pValue: 1, significant: false };
  }
  const target = Math.abs(observedMean) * (1 - 1e-12);
  let atLeast = 0;
  let count = 0;
  const exhaustive = n <= MAX_EXHAUSTIVE_FOLDS;

  if (exhaustive) {
    const total = 2 ** n;
    for (let mask = 0; mask < total; mask++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += (mask & (1 << i)) === 0 ? diffs[i]! : -diffs[i]!;
      if (Math.abs(sum / n) >= target) atLeast++;
    }
    count = total;
  } else {
    const iterations = Math.max(200, Math.floor(opts.iterations ?? 10_000));
    const rand = lcg(opts.seed ?? 12345);
    for (let k = 0; k < iterations; k++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += rand() < 0.5 ? diffs[i]! : -diffs[i]!;
      if (Math.abs(sum / n) >= target) atLeast++;
    }
    // +1 smoothing so a Monte-Carlo p-value is never exactly zero.
    atLeast += 1;
    count = iterations + 1;
  }

  const pValue = Math.min(1, atLeast / count);
  return {
    n,
    observedMean,
    permutations: count,
    exhaustive,
    pValue,
    significant: pValue < alpha && observedMean > 0,
  };
}

// ---------------------------------------------------------------------------
// Multiple testing
// ---------------------------------------------------------------------------

export type MultipleTestingResult = {
  trials: number;
  rawP: number;
  /** Bonferroni-adjusted p — conservative, controls family-wise error. */
  bonferroniP: number;
  /** Šidák-adjusted p — slightly less brutal, assumes independent trials. */
  sidakP: number;
  significant: boolean;
};

/**
 * Penalty for having searched. `trials` is how many parameter sets were scored
 * before the winner was reported — reporting the best of 50 at p=0.03 is not a
 * 3% result.
 */
export function adjustForMultipleTesting(
  rawP: number,
  trials: number,
  alpha = 0.05,
): MultipleTestingResult {
  const t = Math.max(1, Math.floor(trials));
  const p = Math.min(1, Math.max(0, rawP));
  const bonferroniP = Math.min(1, p * t);
  const sidakP = Math.min(1, 1 - (1 - p) ** t);
  return { trials: t, rawP: p, bonferroniP, sidakP, significant: bonferroniP < alpha };
}

/** Benjamini–Hochberg FDR control across a family of p-values. */
export function benjaminiHochberg(
  pValues: readonly number[],
  alpha = 0.05,
): Array<{ index: number; pValue: number; adjustedP: number; rejected: boolean }> {
  const m = pValues.length;
  if (!m) return [];
  const order = pValues
    .map((pValue, index) => ({ index, pValue: Math.min(1, Math.max(0, pValue)) }))
    .sort((a, b) => a.pValue - b.pValue || a.index - b.index);
  const adjusted: number[] = new Array(m);
  let running = 1;
  for (let i = m - 1; i >= 0; i--) {
    running = Math.min(running, (order[i]!.pValue * m) / (i + 1));
    adjusted[i] = Math.min(1, running);
  }
  return order
    .map((o, i) => ({
      index: o.index,
      pValue: o.pValue,
      adjustedP: adjusted[i]!,
      rejected: adjusted[i]! < alpha,
    }))
    .sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Walk-forward wiring
// ---------------------------------------------------------------------------

export type SignificanceVerdict = "significant" | "suggestive" | "not-significant" | "insufficient";

export type WalkForwardSignificance = {
  folds: number;
  /** Per-fold strategy CAGR minus benchmark CAGR (or raw CAGR with no benchmark). */
  diffs: number[];
  /** true when the diffs are strategy − benchmark rather than raw CAGR. */
  paired: boolean;
  meanDiffPct: number;
  tTest: TTestResult;
  sign: SignTestResult;
  permutation: PermutationResult;
  multipleTesting: MultipleTestingResult | null;
  /** The p-value the verdict is based on, after any search penalty. */
  headlineP: number;
  /** Folds needed for the observed effect size to clear alpha at 80% power. */
  foldsForPower: number | null;
  verdict: SignificanceVerdict;
  sentence: string;
};

/** Minimum folds before a p-value means anything at all. */
export const MIN_SIGNIFICANCE_FOLDS = 3;

/** Per-fold CAGR differences: strategy − benchmark when a benchmark exists. */
export function foldCagrDiffs<P>(outcomes: ReadonlyArray<FoldOutcome<P>>): {
  diffs: number[];
  paired: boolean;
} {
  const paired = outcomes.length > 0 && outcomes.every((o) => o.benchmark != null);
  const diffs = outcomes.map((o) =>
    paired ? o.outOfSample.cagrPct - o.benchmark!.cagrPct : o.outOfSample.cagrPct,
  );
  return { diffs, paired };
}

/**
 * Rough folds-needed estimate at 80% power for the observed effect size, using
 * the normal approximation (z_{α/2} = 1.96, z_β = 0.84).
 */
export function foldsForPower(effectSize: number, alpha = 0.05): number | null {
  const d = Math.abs(effectSize);
  if (!(d > 0)) return null;
  const zAlpha = tCritical(1e6, alpha);
  const zBeta = 0.8416;
  return Math.ceil(((zAlpha + zBeta) / d) ** 2);
}

const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const fmtP = (p: number) => (p < 0.001 ? "p<0.001" : `p=${p.toFixed(3)}`);

/**
 * Full significance read on a set of walk-forward folds.
 *
 * `trials` is the number of candidate configurations searched before this one
 * was reported; pass it whenever the result came out of an optimizer, or the
 * p-value will flatter the winner.
 */
export function assessWalkForwardSignificance<P>(
  outcomes: ReadonlyArray<FoldOutcome<P>>,
  opts: { alpha?: number; trials?: number; iterations?: number; seed?: number } = {},
): WalkForwardSignificance {
  const alpha = opts.alpha ?? 0.05;
  const { diffs, paired } = foldCagrDiffs(outcomes);
  const tTest = pairedTTest(diffs, alpha);
  const sign = signTest(diffs, alpha);
  const permutation = signFlipPermutationTest(diffs, {
    alpha,
    iterations: opts.iterations,
    seed: opts.seed,
  });
  const multipleTesting =
    opts.trials && opts.trials > 1
      ? adjustForMultipleTesting(permutation.pValue, opts.trials, alpha)
      : null;

  const rawP = Math.max(tTest.pValue, permutation.pValue);
  const headlineP = multipleTesting ? Math.max(rawP, multipleTesting.bonferroniP) : rawP;
  const positive = tTest.meanDiff > 0;

  let verdict: SignificanceVerdict;
  if (diffs.length < MIN_SIGNIFICANCE_FOLDS) verdict = "insufficient";
  else if (positive && headlineP < alpha && sign.pValue < 0.25) verdict = "significant";
  else if (positive && headlineP < Math.min(0.2, alpha * 4)) verdict = "suggestive";
  else verdict = "not-significant";

  const basis = paired ? "versus the benchmark" : "above zero";
  const searched = multipleTesting ? ` after correcting for ${multipleTesting.trials} searched configs` : "";
  const sentence =
    verdict === "insufficient"
      ? `Only ${diffs.length} fold(s) — too few to test whether the CAGR edge is real.`
      : verdict === "significant"
        ? `CAGR edge of ${fmt(tTest.meanDiff)} per fold ${basis} is unlikely to be chance (${fmtP(headlineP)}, ${sign.positives}/${sign.n} folds positive)${searched}.`
        : verdict === "suggestive"
          ? `CAGR edge of ${fmt(tTest.meanDiff)} per fold ${basis} leans positive but misses the ${Math.round(alpha * 100)}% bar (${fmtP(headlineP)})${searched}.`
          : `CAGR edge of ${fmt(tTest.meanDiff)} per fold ${basis} is indistinguishable from chance (${fmtP(headlineP)})${searched}.`;

  return {
    folds: diffs.length,
    diffs,
    paired,
    meanDiffPct: tTest.meanDiff,
    tTest,
    sign,
    permutation,
    multipleTesting,
    headlineP,
    foldsForPower: foldsForPower(tTest.effectSize, alpha),
    verdict,
    sentence,
  };
}

/** Attach the significance read to an existing walk-forward summary. */
export type SummaryWithSignificance = WalkForwardSummary & {
  significance: WalkForwardSignificance;
};

export function withSignificance<P>(
  summary: WalkForwardSummary,
  outcomes: ReadonlyArray<FoldOutcome<P>>,
  opts: { alpha?: number; trials?: number; iterations?: number; seed?: number } = {},
): SummaryWithSignificance {
  const significance = assessWalkForwardSignificance(outcomes, opts);
  const reasons = [...summary.reasons];
  if (significance.verdict === "not-significant" || significance.verdict === "insufficient") {
    reasons.push(significance.sentence);
  }
  return { ...summary, reasons, significance };
}
