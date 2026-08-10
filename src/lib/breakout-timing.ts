// Signal-age and hold-time diagnostics for the breakout backtest.
//
// The cohort scorecard says *whether* confirmed breakouts pay. This module
// says *when*: how performance decays with the age of the break at entry
// (bars already held beyond the level), how long a "pending" break takes to
// resolve into confirmed or failed, and how the realised hold time relates to
// the outcome. Those three cuts are what the live action mapping needs,
// because the only timing fact available at decision time is the signal's
// age (`bars_since_breakout`).
//
// The module also converts the measurement into a policy: `recommendAgePolicy`
// turns measured per-age expectancy into the age buckets, multipliers and
// stale cut-off that `breakoutAgeAction` applies live.
//
// Pure: trades in, report out. No I/O, no clock, no randomness.

import type { SignalCohort, SignalTrade } from "@/lib/breakout-backtest";
import { summarizeSlice, type SignalSlice } from "@/lib/breakout-diagnostics";

export type Bucket = { label: string; min: number; max: number };

/** Age of the break at entry, in bars held beyond the level. */
export const AGE_BUCKETS: readonly Bucket[] = [
  { label: "0-1", min: 0, max: 1 },
  { label: "2-3", min: 2, max: 3 },
  { label: "4-6", min: 4, max: 6 },
  { label: "7-10", min: 7, max: 10 },
  { label: "11+", min: 11, max: Infinity },
] as const;

/** Bars between the episode's first pending bar and the resolving signal. */
export const LATENCY_BUCKETS: readonly Bucket[] = [
  { label: "1", min: 1, max: 1 },
  { label: "2", min: 2, max: 2 },
  { label: "3-4", min: 3, max: 4 },
  { label: "5+", min: 5, max: Infinity },
] as const;

/** Realised bars held by the hypothetical trade before it exited. */
export const HOLD_BUCKETS: readonly Bucket[] = [
  { label: "1-2", min: 1, max: 2 },
  { label: "3-5", min: 3, max: 5 },
  { label: "6-10", min: 6, max: 10 },
  { label: "11+", min: 11, max: Infinity },
] as const;

function bucketFor(buckets: readonly Bucket[], v: number): Bucket | null {
  return buckets.find((b) => v >= b.min && v <= b.max) ?? null;
}

export type BucketRow = {
  label: string;
  min: number;
  max: number;
  slice: SignalSlice;
  /** Mean per-trade edge in % (same as slice.avgReturnPct, named for clarity). */
  expectancyPct: number;
  /** Share of the cohort's signals that fell in this bucket. */
  sharePct: number;
};

function bucketRows(
  buckets: readonly Bucket[],
  trades: readonly SignalTrade[],
  value: (t: SignalTrade) => number | null,
): BucketRow[] {
  const total = trades.filter((t) => value(t) != null).length;
  return buckets
    .map((b) => {
      const inBucket = trades.filter((t) => {
        const v = value(t);
        return v != null && bucketFor(buckets, v)?.label === b.label;
      });
      const slice = summarizeSlice(inBucket);
      return {
        label: b.label,
        min: b.min,
        max: b.max,
        slice,
        expectancyPct: slice.avgReturnPct,
        sharePct: total ? (slice.trades / total) * 100 : 0,
      };
    })
    .filter((r) => r.slice.trades > 0);
}

export type CohortTiming = {
  cohort: SignalCohort;
  overall: SignalSlice;
  /** Performance by age of the break at entry. */
  byAge: BucketRow[];
  /** Performance by pending -> this-state latency (null-latency trades excluded). */
  byPendingLatency: BucketRow[];
  /** Performance by realised hold time. */
  byHoldTime: BucketRow[];
  /** Mean age at entry, in bars. */
  avgAgeBars: number;
  /** Mean pending -> resolution latency, or null when never measured. */
  avgPendingLatencyBars: number | null;
  /**
   * Slope of expectancy against age, in %-per-bar, from a least-squares fit
   * over the raw trades. Negative = the older the break, the worse it pays.
   */
  ageDecayPctPerBar: number;
  /** Oldest age bucket that still measured a positive expectancy on n>=minTrades. */
  lastPositiveAge: number | null;
};

function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den > 1e-12 ? num / den : 0;
}

export type TimingOptions = {
  /** Minimum bucket size before a bucket is trusted for policy decisions. */
  minTrades?: number;
};

export function cohortTiming(
  cohort: SignalCohort,
  trades: readonly SignalTrade[],
  options: TimingOptions = {},
): CohortTiming {
  const minTrades = options.minTrades ?? 15;
  const ts = trades.filter((t) => t.cohort === cohort);
  const withLatency = ts.filter((t) => t.pendingLatencyBars != null);
  const byAge = bucketRows(AGE_BUCKETS, ts, (t) => t.ageBars);
  const positive = byAge.filter((r) => r.slice.trades >= minTrades && r.expectancyPct > 0);
  return {
    cohort,
    overall: summarizeSlice(ts),
    byAge,
    byPendingLatency: bucketRows(LATENCY_BUCKETS, withLatency, (t) => t.pendingLatencyBars),
    byHoldTime: bucketRows(HOLD_BUCKETS, ts, (t) => t.barsHeld),
    avgAgeBars: ts.length ? ts.reduce((a, t) => a + t.ageBars, 0) / ts.length : 0,
    avgPendingLatencyBars: withLatency.length
      ? withLatency.reduce((a, t) => a + (t.pendingLatencyBars ?? 0), 0) / withLatency.length
      : null,
    ageDecayPctPerBar: slope(ts.map((t) => t.ageBars), ts.map((t) => t.returnPct)),
    lastPositiveAge: positive.length
      ? Math.max(...positive.map((r) => (Number.isFinite(r.max) ? r.max : r.min)))
      : null,
  };
}

/** Live-applicable action mapping derived from the measurement. */
export type AgeBucketRule = {
  /** Inclusive age range in bars (max = Infinity for the tail bucket). */
  minAgeBars: number;
  maxAgeBars: number;
  /** Size multiplier applied to a breakout-driven buy in this age band. */
  mult: number;
  /** True when the band is vetoed outright (mult 0). */
  veto: boolean;
  /** Measured evidence behind the rule. */
  trades: number;
  expectancyPct: number;
  winRatePct: number;
  reason: string;
};

export type RecommendedAgePolicy = {
  cohort: SignalCohort;
  /** Ordered, non-overlapping, exhaustive age bands. */
  rules: AgeBucketRule[];
  /** Age at or beyond which nothing is chased (first vetoed tail band). */
  staleAgeBars: number | null;
  source: string;
  notes: string[];
};

export type RecommendPolicyOptions = TimingOptions & {
  /** Multiplier for bands with too little history to judge. */
  unprovenMult?: number;
  /** Multiplier floor/ceiling applied to measured bands. */
  minMult?: number;
  maxMult?: number;
  source?: string;
};

/**
 * Turn measured per-age expectancy into a size mapping.
 *
 * Rules, in order of precedence:
 *   - measured negative expectancy on an adequate sample -> veto (mult 0)
 *   - measured positive expectancy -> full size, scaled up mildly with the
 *     strength of the edge but never above `maxMult`
 *   - thin sample -> `unprovenMult`
 * Any band older than the last vetoed band inherits the veto: decay is
 * monotone in practice and chasing an even older break cannot be safer.
 */
export function recommendAgePolicy(
  timing: CohortTiming,
  options: RecommendPolicyOptions = {},
): RecommendedAgePolicy {
  const minTrades = options.minTrades ?? 15;
  const unprovenMult = options.unprovenMult ?? 0.7;
  const minMult = options.minMult ?? 0.4;
  const maxMult = options.maxMult ?? 1.2;

  const rules: AgeBucketRule[] = AGE_BUCKETS.map((b) => {
    const row = timing.byAge.find((r) => r.label === b.label);
    const trades = row?.slice.trades ?? 0;
    const exp = row?.expectancyPct ?? 0;
    const win = row?.slice.winRatePct ?? 0;
    if (!row || trades < minTrades) {
      return {
        minAgeBars: b.min,
        maxAgeBars: b.max,
        mult: unprovenMult,
        veto: false,
        trades,
        expectancyPct: exp,
        winRatePct: win,
        reason: `only ${trades} signals aged ${b.label} bars — unproven, size cut`,
      };
    }
    if (exp <= 0) {
      return {
        minAgeBars: b.min,
        maxAgeBars: b.max,
        mult: 0,
        veto: true,
        trades,
        expectancyPct: exp,
        winRatePct: win,
        reason: `age ${b.label} measured ${exp.toFixed(2)}%/trade on n=${trades} — no edge`,
      };
    }
    // Scale gently with the measured edge: +1%/trade earns the full boost.
    const mult = Math.max(minMult, Math.min(maxMult, 0.8 + Math.min(exp, 1) * 0.4));
    return {
      minAgeBars: b.min,
      maxAgeBars: b.max,
      mult,
      veto: false,
      trades,
      expectancyPct: exp,
      winRatePct: win,
      reason: `age ${b.label} pays ${exp.toFixed(2)}%/trade on n=${trades}`,
    };
  });

  // Monotone tail: once a band is vetoed, older bands are too.
  let vetoed = false;
  for (const r of rules) {
    if (r.veto) vetoed = true;
    else if (vetoed) {
      r.veto = true;
      r.mult = 0;
      r.reason = `older than the last band with no measured edge — stale`;
    }
  }

  const staleAgeBars = rules.find((r) => r.veto)?.minAgeBars ?? null;
  const notes: string[] = [];
  notes.push(
    `Expectancy moves ${timing.ageDecayPctPerBar >= 0 ? "+" : ""}${timing.ageDecayPctPerBar.toFixed(3)}%/trade per bar of signal age.`,
  );
  if (staleAgeBars != null) {
    notes.push(`Breaks aged ${staleAgeBars}+ bars are not chased.`);
  }
  if (timing.avgPendingLatencyBars != null) {
    notes.push(
      `${timing.cohort} resolves ${timing.avgPendingLatencyBars.toFixed(1)} bars after the first pending bar on average.`,
    );
  }
  const bestHold = [...timing.byHoldTime]
    .filter((r) => r.slice.trades >= minTrades)
    .sort((a, b) => b.expectancyPct - a.expectancyPct)[0];
  if (bestHold) {
    notes.push(
      `Best realised hold band is ${bestHold.label} bars (${bestHold.expectancyPct.toFixed(2)}%/trade over ${bestHold.slice.trades}).`,
    );
  }

  return {
    cohort: timing.cohort,
    rules,
    staleAgeBars,
    source: options.source ?? "breakout backtest",
    notes,
  };
}

export type BreakoutTimingReport = {
  cohorts: CohortTiming[];
  /** Recommended live mapping for the cohorts the engine can chase. */
  recommended: RecommendedAgePolicy[];
  notes: string[];
};

export function buildBreakoutTimingReport(
  trades: readonly SignalTrade[],
  options: RecommendPolicyOptions = {},
): BreakoutTimingReport {
  const present = Array.from(new Set(trades.map((t) => t.cohort)));
  const order: SignalCohort[] = ["confirmed", "pending", "extended", "failed"];
  const cohorts = order
    .filter((c) => present.includes(c))
    .map((c) => cohortTiming(c, trades, options));
  const recommended = cohorts
    .filter((c) => c.cohort === "confirmed" || c.cohort === "pending")
    .map((c) => recommendAgePolicy(c, options));
  const notes = recommended.flatMap((r) => r.notes.map((n) => `${r.cohort}: ${n}`));
  return { cohorts, recommended, notes };
}
