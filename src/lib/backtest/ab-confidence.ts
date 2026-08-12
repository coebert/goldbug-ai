/**
 * Statistical confidence for the order-batching A/B.
 *
 * A single replay gives one number per arm; it cannot say whether the cost
 * saving is a real edge or one lucky path. This module resamples the paired
 * daily record (both arms, same day, kept together) with a moving-block
 * bootstrap so serial correlation survives, then reports the distribution of
 * the three quantities that decide the verdict:
 *
 *   - cost saving, bps of starting equity (positive = batching cheaper)
 *   - return delta, percentage points (positive = batching earned more)
 *   - drawdown delta, percentage points (positive = batching drew down MORE)
 *
 * Deterministic: a seeded PRNG means the same replay yields the same interval.
 */

export type ArmSeries = {
  equityCurve: Array<{ date: string; totalValue: number }>;
  trades: Array<{ date: string; cost: number }>;
};

export type BootstrapStat = {
  /** Point estimate from the observed (non-resampled) path. */
  observed: number;
  mean: number;
  /** 2.5th percentile of the bootstrap distribution. */
  lower: number;
  /** 97.5th percentile of the bootstrap distribution. */
  upper: number;
  /** Share of resamples strictly greater than zero, 0..1. */
  probPositive: number;
  /** Coarse histogram for plotting: bin centres and counts. */
  histogram: Array<{ center: number; count: number }>;
};

export type AbConfidenceVerdict =
  | "persistent" // cheaper with confidence, and drawdown not worse
  | "cheaper_but_riskier" // saving holds up but drawdown deteriorates
  | "inconclusive" // interval straddles zero
  | "not_supported"; // saving is absent or negative with confidence

export type AbConfidenceResult = {
  iterations: number;
  blockDays: number;
  days: number;
  costSavingBps: BootstrapStat;
  returnDeltaPct: BootstrapStat;
  drawdownDeltaPct: BootstrapStat;
  /** Share of resamples where batching is cheaper AND no worse on drawdown. */
  probCheaperAndNoWorse: number;
  verdict: AbConfidenceVerdict;
  summary: string;
};

/** Mulberry32 — small, fast, fully deterministic. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function histogram(values: number[], bins = 24): Array<{ center: number; count: number }> {
  if (values.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) return [{ center: min, count: values.length }];
  const width = (max - min) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / width)));
    counts[idx]! += 1;
  }
  return counts.map((count, i) => ({ center: min + width * (i + 0.5), count }));
}

function statFrom(samples: number[], observed: number): BootstrapStat {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  const positive = samples.reduce((a, v) => a + (v > 0 ? 1 : 0), 0);
  return {
    observed,
    mean,
    lower: quantile(sorted, 0.025),
    upper: quantile(sorted, 0.975),
    probPositive: samples.length ? positive / samples.length : 0,
    histogram: histogram(samples),
  };
}

/** Max drawdown (%) of a path built from a sequence of daily growth factors. */
function drawdownFromFactors(factors: number[]): number {
  let value = 1;
  let peak = 1;
  let worst = 0;
  for (const f of factors) {
    value *= f;
    if (value > peak) peak = value;
    const dd = peak > 0 ? ((peak - value) / peak) * 100 : 0;
    if (dd > worst) worst = dd;
  }
  return worst;
}

type DailyRecord = {
  batchedFactor: number;
  unbatchedFactor: number;
  batchedCost: number;
  unbatchedCost: number;
};

/** Align both arms on the dates they share and attach that day's trade costs. */
function pairDays(batched: ArmSeries, unbatched: ArmSeries): DailyRecord[] {
  const un = new Map(unbatched.equityCurve.map((p) => [p.date, Number(p.totalValue) || 0]));
  const costB = new Map<string, number>();
  for (const t of batched.trades) costB.set(t.date, (costB.get(t.date) ?? 0) + (Number(t.cost) || 0));
  const costU = new Map<string, number>();
  for (const t of unbatched.trades)
    costU.set(t.date, (costU.get(t.date) ?? 0) + (Number(t.cost) || 0));

  const out: DailyRecord[] = [];
  let prevB = 0;
  let prevU = 0;
  for (const p of batched.equityCurve) {
    const b = Number(p.totalValue) || 0;
    const u = un.get(p.date);
    if (u == null) continue;
    if (prevB > 0 && prevU > 0) {
      out.push({
        batchedFactor: b / prevB,
        unbatchedFactor: u / prevU,
        batchedCost: costB.get(p.date) ?? 0,
        unbatchedCost: costU.get(p.date) ?? 0,
      });
    }
    prevB = b;
    prevU = u;
  }
  return out;
}

export type AbConfidenceInput = {
  batched: ArmSeries;
  unbatched: ArmSeries;
  /** Starting equity, used to express costs in bps. */
  startingValue: number;
  iterations?: number;
  /** Moving-block length in trading days; defaults to ~n^(1/3). */
  blockDays?: number;
  seed?: number;
  /** Drawdown deterioration (pp) still counted as "no worse". */
  drawdownTolerancePct?: number;
};

export function computeAbConfidence(input: AbConfidenceInput): AbConfidenceResult {
  const days = pairDays(input.batched, input.unbatched);
  const n = days.length;
  const iterations = Math.max(200, Math.min(5000, input.iterations ?? 1000));
  const blockDays = Math.max(
    1,
    Math.min(n || 1, input.blockDays ?? Math.round(Math.cbrt(Math.max(n, 1))) + 4),
  );
  const tol = input.drawdownTolerancePct ?? 0.5;
  const startingValue = Number(input.startingValue) > 0 ? Number(input.startingValue) : 1;

  const empty: BootstrapStat = {
    observed: 0,
    mean: 0,
    lower: 0,
    upper: 0,
    probPositive: 0,
    histogram: [],
  };
  if (n < 10) {
    return {
      iterations: 0,
      blockDays,
      days: n,
      costSavingBps: empty,
      returnDeltaPct: empty,
      drawdownDeltaPct: empty,
      probCheaperAndNoWorse: 0,
      verdict: "inconclusive",
      summary: "Too few overlapping bars to resample — run a longer replay for confidence bands.",
    };
  }

  const obsCostSaving =
    ((days.reduce((a, d) => a + d.unbatchedCost - d.batchedCost, 0)) / startingValue) * 10_000;
  const obsReturnDelta =
    (days.reduce((a, d) => a * d.batchedFactor, 1) -
      days.reduce((a, d) => a * d.unbatchedFactor, 1)) *
    100;
  const obsDrawdownDelta =
    drawdownFromFactors(days.map((d) => d.batchedFactor)) -
    drawdownFromFactors(days.map((d) => d.unbatchedFactor));

  const rng = makeRng(input.seed ?? 20260812);
  const costSamples: number[] = [];
  const returnSamples: number[] = [];
  const ddSamples: number[] = [];
  let bothGood = 0;
  const blocks = Math.ceil(n / blockDays);

  for (let it = 0; it < iterations; it++) {
    const bFactors: number[] = [];
    const uFactors: number[] = [];
    let costDelta = 0;
    for (let b = 0; b < blocks; b++) {
      const start = Math.floor(rng() * n);
      for (let k = 0; k < blockDays && bFactors.length < n; k++) {
        const d = days[(start + k) % n]!;
        bFactors.push(d.batchedFactor);
        uFactors.push(d.unbatchedFactor);
        costDelta += d.unbatchedCost - d.batchedCost;
      }
    }
    const costBps = (costDelta / startingValue) * 10_000;
    const retDelta =
      (bFactors.reduce((a, f) => a * f, 1) - uFactors.reduce((a, f) => a * f, 1)) * 100;
    const ddDelta = drawdownFromFactors(bFactors) - drawdownFromFactors(uFactors);
    costSamples.push(costBps);
    returnSamples.push(retDelta);
    ddSamples.push(ddDelta);
    if (costBps > 0 && ddDelta <= tol) bothGood++;
  }

  const costSavingBps = statFrom(costSamples, obsCostSaving);
  const returnDeltaPct = statFrom(returnSamples, obsReturnDelta);
  const drawdownDeltaPct = statFrom(ddSamples, obsDrawdownDelta);
  const probCheaperAndNoWorse = bothGood / iterations;

  const savingHolds = costSavingBps.lower > 0;
  const savingRefuted = costSavingBps.upper < 0;
  const ddWorse = drawdownDeltaPct.lower > tol;

  let verdict: AbConfidenceVerdict;
  if (savingRefuted) verdict = "not_supported";
  else if (savingHolds && ddWorse) verdict = "cheaper_but_riskier";
  else if (savingHolds && probCheaperAndNoWorse >= 0.8) verdict = "persistent";
  else verdict = "inconclusive";

  const fmt = (v: number, dp = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(dp)}`;
  const band = `95% CI ${fmt(costSavingBps.lower)} to ${fmt(costSavingBps.upper)} bps`;
  const ddBand = `drawdown delta ${fmt(drawdownDeltaPct.lower, 2)} to ${fmt(drawdownDeltaPct.upper, 2)} pp`;
  const summary =
    verdict === "persistent"
      ? `Cost saving persists across resamples (${band}) and drawdown does not deteriorate — ${(probCheaperAndNoWorse * 100).toFixed(0)}% of paths are cheaper and no riskier.`
      : verdict === "cheaper_but_riskier"
        ? `Batching is reliably cheaper (${band}) but pays for it in risk: ${ddBand}.`
        : verdict === "not_supported"
          ? `Batching is reliably more expensive on this data (${band}).`
          : `Not separable from noise: ${band}, ${ddBand}. Only ${(probCheaperAndNoWorse * 100).toFixed(0)}% of paths are both cheaper and no riskier.`;

  return {
    iterations,
    blockDays,
    days: n,
    costSavingBps,
    returnDeltaPct,
    drawdownDeltaPct,
    probCheaperAndNoWorse,
    verdict,
    summary,
  };
}
