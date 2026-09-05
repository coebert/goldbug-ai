/**
 * Pure maths for the learned decision model.
 *
 * Design choices, and why:
 *  - Features are z-scored WITHIN each date (cross-sectionally). The model
 *    should learn "which name looks best today", not "was 2026 a good year".
 *  - The label is the forward return over the horizon, also demeaned within
 *    the date. That strips out market direction, which the regime layer
 *    already handles, and leaves pure selection edge.
 *  - The fit is ridge regression (closed form). With ~18 correlated technical
 *    features and a few thousand rows, an unregularised fit would just
 *    memorise noise; the L2 penalty is what keeps the coefficients stable.
 *  - Validation is walk-forward: fit on the earlier dates, measure on the
 *    later ones. Never in-sample.
 */

export type Sample = {
  date: string;
  symbol: string;
  /** Raw feature values, aligned to FEATURE_KEYS; null = missing. */
  x: Array<number | null>;
  /** Label over the horizon (forward return, or a risk/cost-adjusted variant). */
  y: number;
  /**
   * Observation weight. Days where this account actually committed capital to
   * the name matter more than days it merely looked at it, so those rows are
   * weighted up. Defaults to 1.
   */
  w?: number;
};

export type NormalisedSample = {
  date: string;
  symbol: string;
  z: number[];
  y: number;
  w: number;
};


const WINSOR = 3;

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function stdev(v: number[], m: number): number {
  if (v.length < 2) return 0;
  const s = v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1);
  return Math.sqrt(s);
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Cross-sectional standardisation. Each date is normalised independently, so
 * a date with fewer than `minPerDate` usable rows is dropped: a z-score
 * across two symbols is meaningless.
 */
export function normaliseByDate(samples: Sample[], featureCount: number, minPerDate = 5): NormalisedSample[] {
  const byDate = new Map<string, Sample[]>();
  for (const s of samples) {
    const arr = byDate.get(s.date);
    if (arr) arr.push(s);
    else byDate.set(s.date, [s]);
  }

  const out: NormalisedSample[] = [];
  for (const [date, rows] of byDate) {
    if (rows.length < minPerDate) continue;

    // Per-feature mean/sd across this date's symbols, ignoring missing values.
    const stats: Array<{ m: number; sd: number }> = [];
    for (let j = 0; j < featureCount; j++) {
      const vals: number[] = [];
      for (const r of rows) {
        const v = r.x[j];
        if (v !== null && v !== undefined && Number.isFinite(v)) vals.push(v);
      }
      const m = mean(vals);
      stats.push({ m, sd: stdev(vals, m) });
    }

    const ys = rows.map((r) => r.y);
    const ym = mean(ys);

    for (const r of rows) {
      const z: number[] = [];
      for (let j = 0; j < featureCount; j++) {
        const v = r.x[j];
        const { m, sd } = stats[j]!;
        // Missing or degenerate (every symbol identical) => neutral 0.
        z.push(v === null || v === undefined || !Number.isFinite(v) || sd <= 0 ? 0 : clamp((v - m) / sd, -WINSOR, WINSOR));
      }
      out.push({
        date,
        symbol: r.symbol,
        z,
        y: r.y - ym,
        w: Number.isFinite(r.w) && (r.w ?? 1) > 0 ? Math.min(8, r.w!) : 1,
      });
    }
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** Solve (XᵀX + λI) w = Xᵀy by Gaussian elimination with partial pivoting. */
export function ridgeFit(rows: NormalisedSample[], featureCount: number, lambda: number): number[] {
  const n = featureCount;
  const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);

  for (const r of rows) {
    const wt = r.w > 0 ? r.w : 1;
    for (let i = 0; i < n; i++) {
      const zi = r.z[i]! * wt;
      b[i]! += zi * r.y;
      for (let j = i; j < n; j++) A[i]![j]! += zi * r.z[j]!;
    }
  }

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) A[i]![j] = A[j]![i]!;
    A[i]![i]! += lambda;
  }

  // Gaussian elimination.
  const M: number[][] = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    if (Math.abs(M[pivot]![col]!) < 1e-12) continue;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    const p = M[col]![col]!;
    for (let j = col; j <= n; j++) M[col]![j]! /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r]![j]! -= f * M[col]![j]!;
    }
  }
  return Array.from({ length: n }, (_, i) => {
    const v = M[i]![n]!;
    return Number.isFinite(v) ? v : 0;
  });
}

export function score(z: number[], w: number[]): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += (z[i] ?? 0) * w[i]!;
  return s;
}

function rank(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]!.i] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(a: number[], b: number[]): number | null {
  if (a.length < 3) return null;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : null;
}

export type EvalMetrics = {
  dates: number;
  samples: number;
  /** Mean per-date rank correlation between score and forward return. */
  mean_ic: number | null;
  /** t-statistic of the per-date ICs — above ~2 means the edge is real. */
  ic_t_stat: number | null;
  /** Share of dates with a positive IC. */
  ic_hit_rate: number | null;
  /** Mean forward return of the top-ranked name minus the bottom-ranked. */
  top_bottom_spread_pct: number | null;
  /** Mean forward return of the model's top pick each date. */
  top_pick_return_pct: number | null;
  /** Share of dates where the top pick beat the day's average. */
  top_pick_hit_rate: number | null;
};

export function evaluate(rows: NormalisedSample[], w: number[]): EvalMetrics {
  const byDate = new Map<string, NormalisedSample[]>();
  for (const r of rows) {
    const a = byDate.get(r.date);
    if (a) a.push(r);
    else byDate.set(r.date, [r]);
  }

  const ics: number[] = [];
  const spreads: number[] = [];
  const topReturns: number[] = [];
  let topWins = 0;
  let samples = 0;

  for (const [, group] of byDate) {
    if (group.length < 5) continue;
    samples += group.length;
    const s = group.map((g) => score(g.z, w));
    const y = group.map((g) => g.y);
    const ic = pearson(rank(s), rank(y));
    if (ic !== null) ics.push(ic);

    const order = group.map((_, i) => i).sort((a, b) => s[b]! - s[a]!);
    const top = y[order[0]!]!;
    const bottom = y[order[order.length - 1]!]!;
    spreads.push(top - bottom);
    topReturns.push(top);
    if (top > 0) topWins++;
  }

  const icMean = ics.length ? mean(ics) : null;
  const icSd = ics.length > 1 ? stdev(ics, icMean!) : 0;
  return {
    dates: ics.length,
    samples,
    mean_ic: icMean,
    ic_t_stat: icMean !== null && icSd > 0 ? (icMean / icSd) * Math.sqrt(ics.length) : null,
    ic_hit_rate: ics.length ? ics.filter((v) => v > 0).length / ics.length : null,
    top_bottom_spread_pct: spreads.length ? mean(spreads) * 100 : null,
    top_pick_return_pct: topReturns.length ? mean(topReturns) * 100 : null,
    top_pick_hit_rate: topReturns.length ? topWins / topReturns.length : null,
  };
}

export type BucketWeights = Record<string, number>;

/**
 * Collapse the coefficient vector into the five signal buckets the AI already
 * uses, expressed as percentages summing to 100. This is what gets handed to
 * the model as "here is what actually worked on your account".
 */
export function bucketWeights(
  keys: readonly string[],
  coefs: number[],
  bucketFor: (key: string) => string | null,
): BucketWeights {
  const totals: Record<string, number> = {};
  keys.forEach((k, i) => {
    const b = bucketFor(k);
    if (!b) return;
    totals[b] = (totals[b] ?? 0) + Math.abs(coefs[i] ?? 0);
  });
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  if (sum <= 0) return totals;
  const out: BucketWeights = {};
  for (const [k, v] of Object.entries(totals)) out[k] = Math.round((v / sum) * 1000) / 10;
  return out;
}

export type FitResult = {
  lambda: number;
  coefficients: number[];
  train: EvalMetrics;
  test: EvalMetrics;
};

/**
 * Walk-forward fit: train on the earliest `trainFrac` of dates, validate on
 * the rest, and pick the ridge penalty that generalises best (highest
 * out-of-sample mean IC) rather than the one that fits history hardest.
 */
export function fitWalkForward(
  rows: NormalisedSample[],
  featureCount: number,
  opts: { trainFrac?: number; lambdas?: number[] } = {},
): { best: FitResult; candidates: FitResult[]; trainDates: number; testDates: number } | null {
  const trainFrac = opts.trainFrac ?? 0.7;
  const lambdas = opts.lambdas ?? [1, 5, 20, 100, 500, 2000];

  const dates = Array.from(new Set(rows.map((r) => r.date))).sort();
  if (dates.length < 8) return null;
  const cut = dates[Math.max(1, Math.floor(dates.length * trainFrac)) - 1]!;

  const train = rows.filter((r) => r.date <= cut);
  const test = rows.filter((r) => r.date > cut);
  if (train.length < 50 || test.length < 20) return null;

  const candidates: FitResult[] = lambdas.map((lambda) => {
    const coefficients = ridgeFit(train, featureCount, lambda);
    return {
      lambda,
      coefficients,
      train: evaluate(train, coefficients),
      test: evaluate(test, coefficients),
    };
  });

  const best = candidates.reduce((a, b) => ((b.test.mean_ic ?? -Infinity) > (a.test.mean_ic ?? -Infinity) ? b : a));
  return {
    best,
    candidates,
    trainDates: new Set(train.map((r) => r.date)).size,
    testDates: new Set(test.map((r) => r.date)).size,
  };
}

/** Refit on the full history using the penalty chosen out of sample. */
export function refitFull(rows: NormalisedSample[], featureCount: number, lambda: number): number[] {
  return ridgeFit(rows, featureCount, lambda);
}
