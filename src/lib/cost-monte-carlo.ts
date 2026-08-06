/**
 * Monte Carlo cost stress test.
 *
 * The cost *sweep* scales all frictions together and the cost *sensitivity*
 * grid varies two axes on a fixed lattice. Neither answers the question a
 * live account actually faces: costs are not a knob you choose, they are a
 * random variable. Commission schedules change, the per-ticket minimum bites
 * differently on small tickets, and realised slippage is a fat-tailed draw
 * that widens exactly when everything else goes wrong.
 *
 * This module samples (commissionBps, minCommission, slippageBps) jointly from
 * realistic ranges — with an optional common "stress factor" so the three
 * co-move the way they do in a bad tape — runs the strategy under each draw,
 * and reports the *distribution* of net CAGR and max drawdown rather than a
 * single point estimate.
 *
 * The churn question is answered by cohorts: the same cost draws are replayed
 * against configurations that differ only in turnover (min-hold / re-entry
 * gap). Comparing the per-cohort cost elasticity shows how much of the
 * dispersion is turnover-driven churn as opposed to market path.
 *
 * Everything here is pure and deterministic: same seed → same draws → same
 * summary. No network, no database, no broker.
 */
import { mcRng } from "./monte-carlo-events";
import type { Frictions } from "./broker-simulator";

// ------------------------------------------------------------------ draws

/** One sampled execution-cost world. */
export type CostDraw = {
  /** Proportional commission, bps of notional per side. */
  commissionBps: number;
  /** Per-ticket commission floor, account currency. */
  minCommission: number;
  /** Half-spread + impact assumption per side, bps of notional. */
  slippageBps: number;
  /** 0-1 common stress factor that produced this draw (0 = benign tail). */
  stress: number;
};

/** Inclusive sampling range for one cost axis. */
export type CostRange = { min: number; max: number };

export type CostDrawSpec = {
  commissionBps: CostRange;
  minCommission: CostRange;
  slippageBps: CostRange;
  /**
   * How much of each axis is driven by a single shared stress factor rather
   * than its own independent draw (0 = fully independent, 1 = perfectly
   * correlated). Real cost shocks are correlated, so the default is 0.5.
   */
  commonFactor?: number;
  /**
   * Tail shape of the slippage draw. `linear` is uniform across the range;
   * `fat` skews draws toward the cheap end but keeps a long expensive tail,
   * which is what realised slippage looks like.
   */
  slippageTail?: "linear" | "fat";
};

/**
 * Realistic retail (Saxo-like) ranges: 4-14bps commission, £2-£10 ticket
 * minimum, 2-25bps of round-trip-per-side slippage with a fat tail.
 */
export const DEFAULT_COST_SPEC: CostDrawSpec = {
  commissionBps: { min: 4, max: 14 },
  minCommission: { min: 2, max: 10 },
  slippageBps: { min: 2, max: 25 },
  commonFactor: 0.5,
  slippageTail: "fat",
};

const lerp = (r: CostRange, u: number) => r.min + (r.max - r.min) * u;

function assertRange(name: string, r: CostRange): void {
  if (!Number.isFinite(r.min) || !Number.isFinite(r.max) || r.min < 0 || r.max < r.min) {
    throw new Error(`sampleCostDraws: invalid range for ${name} (${r.min}…${r.max})`);
  }
}

/**
 * Draw `n` cost worlds. Each axis mixes its own uniform draw with a shared
 * stress factor, so a "bad" world tends to be bad on every axis at once.
 */
export function sampleCostDraws(
  n: number,
  spec: CostDrawSpec = DEFAULT_COST_SPEC,
  seed = 20260806,
): CostDraw[] {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`sampleCostDraws: bad n ${n}`);
  assertRange("commissionBps", spec.commissionBps);
  assertRange("minCommission", spec.minCommission);
  assertRange("slippageBps", spec.slippageBps);
  const w = Math.min(1, Math.max(0, spec.commonFactor ?? 0.5));
  const rng = mcRng(seed);
  const out: CostDraw[] = [];
  for (let i = 0; i < n; i += 1) {
    const stress = rng();
    const mix = (u: number) => w * stress + (1 - w) * u;
    const slipU = mix(rng());
    // Fat tail: squaring pulls the mass toward the cheap end while leaving the
    // expensive end reachable, so the p95 world stays genuinely painful.
    const slipShaped = spec.slippageTail === "linear" ? slipU : slipU * slipU;
    out.push({
      commissionBps: lerp(spec.commissionBps, mix(rng())),
      minCommission: lerp(spec.minCommission, mix(rng())),
      slippageBps: lerp(spec.slippageBps, slipShaped),
      stress,
    });
  }
  return out;
}

/** Overlay a draw onto a baseline friction model, leaving other terms intact. */
export function frictionsFromDraw(base: Frictions, draw: CostDraw): Frictions {
  return {
    ...base,
    commissionBps: draw.commissionBps,
    minCommission: draw.minCommission,
    slippageBps: draw.slippageBps,
  };
}

// ------------------------------------------------------------- outcomes

/** A turnover cohort: a label plus the measured trade intensity it produced. */
export type TurnoverCohort = {
  /** e.g. "high churn (min-hold 2d)". */
  label: string;
  /** Round-trips per 252 bars measured on the baseline cost draw. */
  tradesPerYear: number;
};

/** One completed backtest under one cost draw. */
export type CostTrial = {
  cohort: string;
  draw: CostDraw;
  netCagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  tradesPerYear: number;
  /** Total cost of trading as % of starting equity. */
  feeDragPct: number;
};

export type Percentiles = {
  p5: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  mean: number;
};

/** Linear-interpolated percentile of an unsorted sample. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 1) return xs[0]!;
  const pos = Math.min(Math.max(q, 0), 1) * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return xs[lo]! + (xs[hi]! - xs[lo]!) * frac;
}

export function describeDistribution(values: readonly number[]): Percentiles {
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
  return {
    p5: percentile(values, 0.05),
    p25: percentile(values, 0.25),
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
    mean,
  };
}

/** Mean of the worst `share` of the sample (expected shortfall). */
export function cvar(values: readonly number[], share = 0.05): number {
  if (values.length === 0) return Number.NaN;
  const xs = [...values].sort((a, b) => a - b);
  const k = Math.max(1, Math.round(xs.length * Math.min(Math.max(share, 0), 1)));
  return xs.slice(0, k).reduce((a, b) => a + b, 0) / k;
}

// ------------------------------------------------------------- regression

export type CostSensitivity = {
  /** Net CAGR % points lost per additional bp of commission. */
  perCommissionBp: number;
  /** Net CAGR % points lost per additional £1 of ticket minimum. */
  perMinFee: number;
  /** Net CAGR % points lost per additional bp of slippage. */
  perSlippageBp: number;
  /** Fraction of net-CAGR variance the three cost axes explain (0-1). */
  r2: number;
};

/**
 * Multivariate OLS of an outcome on the three cost axes. Partial slopes are
 * what matter here: the axes are correlated by construction, so univariate
 * slopes would double-count the shared stress factor.
 */
export function regressOnCosts(
  trials: readonly CostTrial[],
  outcome: (t: CostTrial) => number = (t) => t.netCagrPct,
): CostSensitivity {
  const zero: CostSensitivity = { perCommissionBp: 0, perMinFee: 0, perSlippageBp: 0, r2: 0 };
  if (trials.length < 6) return zero;
  const X = trials.map((t) => [1, t.draw.commissionBps, t.draw.minCommission, t.draw.slippageBps]);
  const y = trials.map(outcome);
  const k = 4;
  // Normal equations XtX b = Xty, solved by Gauss-Jordan with partial pivoting.
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let i = 0; i < X.length; i += 1) {
    for (let a = 0; a < k; a += 1) {
      for (let b = 0; b < k; b += 1) A[a]![b]! += X[i]![a]! * X[i]![b]!;
      A[a]![k]! += X[i]![a]! * y[i]!;
    }
  }
  for (let col = 0; col < k; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < k; r += 1) {
      if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(A[pivot]![col]!) < 1e-12) return zero;
    [A[col], A[pivot]] = [A[pivot]!, A[col]!];
    const p = A[col]![col]!;
    for (let c = col; c <= k; c += 1) A[col]![c]! /= p;
    for (let r = 0; r < k; r += 1) {
      if (r === col) continue;
      const f = A[r]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= k; c += 1) A[r]![c]! -= f * A[col]![c]!;
    }
  }
  const beta = A.map((row) => row[k]!);
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < y.length; i += 1) {
    const fit = beta.reduce((s, b, j) => s + b * X[i]![j]!, 0);
    ssTot += (y[i]! - my) ** 2;
    ssRes += (y[i]! - fit) ** 2;
  }
  return {
    perCommissionBp: beta[1]!,
    perMinFee: beta[2]!,
    perSlippageBp: beta[3]!,
    r2: ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0,
  };
}

// -------------------------------------------------------------- summaries

export type CohortSummary = {
  cohort: string;
  trials: number;
  tradesPerYear: number;
  netCagr: Percentiles;
  maxDrawdown: Percentiles;
  feeDrag: Percentiles;
  /** Share of draws with net CAGR above zero. */
  profitableRate: number;
  /** Share of draws whose max drawdown stays within the ceiling. */
  drawdownPassRate: number;
  /** Mean net CAGR of the worst 5% of cost worlds. */
  cvarNetCagr: number;
  /** Mean drawdown of the worst 5% of cost worlds. */
  cvarDrawdown: number;
  /** Net CAGR spread between the cheapest and most expensive quartile worlds. */
  costSpreadPct: number;
  sensitivity: CostSensitivity;
  /** Drawdown % points added per bp of slippage — robustness decay. */
  drawdownSlippageSlope: number;
};

export function summariseCohort(
  cohort: string,
  trials: readonly CostTrial[],
  drawdownCeilingPct = 30,
): CohortSummary {
  const net = trials.map((t) => t.netCagrPct);
  const dd = trials.map((t) => t.maxDrawdownPct);
  const tpy = trials.length
    ? trials.reduce((a, t) => a + t.tradesPerYear, 0) / trials.length
    : 0;
  const ddRegression = regressOnCosts(trials, (t) => t.maxDrawdownPct);
  return {
    cohort,
    trials: trials.length,
    tradesPerYear: tpy,
    netCagr: describeDistribution(net),
    maxDrawdown: describeDistribution(dd),
    feeDrag: describeDistribution(trials.map((t) => t.feeDragPct)),
    profitableRate: trials.length ? trials.filter((t) => t.netCagrPct > 0).length / trials.length : 0,
    drawdownPassRate: trials.length
      ? trials.filter((t) => t.maxDrawdownPct <= drawdownCeilingPct).length / trials.length
      : 0,
    cvarNetCagr: cvar(net, 0.05),
    cvarDrawdown: -cvar(dd.map((d) => -d), 0.05),
    costSpreadPct: percentile(net, 0.75) - percentile(net, 0.25),
    sensitivity: regressOnCosts(trials),
    drawdownSlippageSlope: ddRegression.perSlippageBp,
  };
}

export function summariseByCohort(
  trials: readonly CostTrial[],
  drawdownCeilingPct = 30,
): CohortSummary[] {
  const groups = new Map<string, CostTrial[]>();
  for (const t of trials) {
    const arr = groups.get(t.cohort) ?? [];
    arr.push(t);
    groups.set(t.cohort, arr);
  }
  return [...groups.entries()]
    .map(([name, arr]) => summariseCohort(name, arr, drawdownCeilingPct))
    .sort((a, b) => a.tradesPerYear - b.tradesPerYear);
}

// ------------------------------------------------------- churn attribution

export type ChurnVerdict = "churn-dominated" | "churn-sensitive" | "churn-tolerant";

export type ChurnImpact = {
  /** Lowest-turnover cohort in the run. */
  baseline: string;
  /** Highest-turnover cohort in the run. */
  churned: string;
  /** Extra round-trips per year the churned cohort takes on. */
  extraTradesPerYear: number;
  /** Median net CAGR given up by churning (positive = churn costs return). */
  medianCagrCostPct: number;
  /** Median net CAGR lost per extra round-trip per year. */
  cagrPerExtraTrade: number;
  /** Extra fee drag % of equity attributable to the churn. */
  extraFeeDragPct: number;
  /** Drawdown % points added by churning at the 95th-percentile cost world. */
  tailDrawdownCostPct: number;
  /** Change in the share of cost worlds that stay profitable. */
  profitableRateDelta: number;
  /** How much wider the cost-driven CAGR spread gets when churning. */
  spreadAmplification: number;
  verdict: ChurnVerdict;
};

/**
 * Compare the lowest- and highest-turnover cohorts under the *same* cost
 * draws. Because the market path is identical, the difference is churn.
 */
export function churnImpact(summaries: readonly CohortSummary[]): ChurnImpact | null {
  const usable = summaries.filter((s) => s.trials > 0);
  if (usable.length < 2) return null;
  const sorted = [...usable].sort((a, b) => a.tradesPerYear - b.tradesPerYear);
  const lo = sorted[0]!;
  const hi = sorted[sorted.length - 1]!;
  const extra = hi.tradesPerYear - lo.tradesPerYear;
  const cagrCost = lo.netCagr.median - hi.netCagr.median;
  const perTrade = extra > 0 ? cagrCost / extra : 0;
  const tailDd = hi.maxDrawdown.p95 - lo.maxDrawdown.p95;
  const spreadAmp = lo.costSpreadPct > 1e-9 ? hi.costSpreadPct / lo.costSpreadPct : 1;
  const profitDelta = hi.profitableRate - lo.profitableRate;
  const verdict: ChurnVerdict =
    cagrCost >= 3 || profitDelta <= -0.2 || tailDd >= 5
      ? "churn-dominated"
      : cagrCost >= 1 || spreadAmp >= 1.5
        ? "churn-sensitive"
        : "churn-tolerant";
  return {
    baseline: lo.cohort,
    churned: hi.cohort,
    extraTradesPerYear: extra,
    medianCagrCostPct: cagrCost,
    cagrPerExtraTrade: perTrade,
    extraFeeDragPct: hi.feeDrag.median - lo.feeDrag.median,
    tailDrawdownCostPct: tailDd,
    profitableRateDelta: profitDelta,
    spreadAmplification: spreadAmp,
    verdict,
  };
}

export const CHURN_VERDICT_LABEL: Record<ChurnVerdict, string> = {
  "churn-dominated": "churn dominates — costs eat the edge",
  "churn-sensitive": "churn is material — cap turnover",
  "churn-tolerant": "churn is affordable at these costs",
};

/** Which cost axis explains most of the damage for a cohort. */
export function dominantAxis(
  s: CostSensitivity,
  spec: CostDrawSpec = DEFAULT_COST_SPEC,
): "commission" | "min fee" | "slippage" {
  const span = (r: CostRange) => r.max - r.min;
  const impacts: Array<[ "commission" | "min fee" | "slippage", number ]> = [
    ["commission", Math.abs(s.perCommissionBp) * span(spec.commissionBps)],
    ["min fee", Math.abs(s.perMinFee) * span(spec.minCommission)],
    ["slippage", Math.abs(s.perSlippageBp) * span(spec.slippageBps)],
  ];
  impacts.sort((a, b) => b[1] - a[1]);
  return impacts[0]![0];
}

const pct = (v: number, d = 1) => `${v >= 0 ? "" : ""}${v.toFixed(d)}%`;

export function formatCohort(s: CohortSummary): string {
  return (
    `${s.cohort.padEnd(26)} ${s.tradesPerYear.toFixed(0).padStart(4)} trades/yr  ` +
    `net CAGR p5 ${pct(s.netCagr.p5).padStart(7)} / med ${pct(s.netCagr.median).padStart(7)} / p95 ${pct(s.netCagr.p95).padStart(7)}  ` +
    `maxDD med ${pct(s.maxDrawdown.median).padStart(6)} / p95 ${pct(s.maxDrawdown.p95).padStart(6)}  ` +
    `profitable ${(s.profitableRate * 100).toFixed(0)}%  DD-pass ${(s.drawdownPassRate * 100).toFixed(0)}%`
  );
}

/** Plain-language read-out of what the stress test found. */
export function explainChurn(
  impact: ChurnImpact | null,
  spec: CostDrawSpec = DEFAULT_COST_SPEC,
  churnedSensitivity?: CostSensitivity,
): string {
  if (!impact) return "Not enough cohorts to attribute churn — run at least two turnover levels.";
  const axis = churnedSensitivity ? dominantAxis(churnedSensitivity, spec) : null;
  const parts = [
    `${CHURN_VERDICT_LABEL[impact.verdict]}.`,
    `Going from ${impact.baseline} to ${impact.churned} adds ${impact.extraTradesPerYear.toFixed(0)} round-trips/yr`,
    `and costs ${impact.medianCagrCostPct.toFixed(1)}% points of median net CAGR`,
    `(${impact.cagrPerExtraTrade.toFixed(2)}% per extra trade/yr, ${impact.extraFeeDragPct.toFixed(1)}% more fee drag).`,
    `Tail drawdown widens by ${impact.tailDrawdownCostPct.toFixed(1)}% points at the p95 cost world`,
    `and the cost-driven CAGR spread is ${impact.spreadAmplification.toFixed(2)}x wider.`,
  ];
  if (axis) parts.push(`Dominant cost axis for the churned cohort: ${axis}.`);
  return parts.join(" ");
}
