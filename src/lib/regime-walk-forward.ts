// Regime-segmented walk-forward evaluation.
//
// A single all-history backtest hides the thing that actually matters: does
// the optimised parameter set keep its net CAGR and its drawdown discipline
// when the tape is *only* bull, *only* bear, or *only* chop?
//
// This module is the pure half of that answer:
//   * build a benchmark index from the tape,
//   * label every bar bull / bear / sideways from trailing trend + drawdown,
//   * cut the history into rolling train/test walk-forward windows,
//   * tag each out-of-sample window with the regime it mostly lived in,
//   * aggregate net CAGR and drawdown per regime, with a stability read.
//
// No network, no broker, no database — all deterministic so the verdicts
// can be unit tested.

import type { EquityPoint } from "./backtest-metrics";
import type { RegimeCostSummary, WindowCosts } from "./regime-cost-attribution";


export type RegimeLabel = "bull" | "bear" | "sideways";
export const REGIMES: readonly RegimeLabel[] = ["bull", "bear", "sideways"] as const;

export type IndexPoint = { date: string; value: number };

/** Bars as produced by `buildRealTape` — only what this module needs. */
export type TapeBarLike = { date: string; closes: Record<string, number> };

/**
 * Equal-weight benchmark index from the tape, rebased to 100. Symbols that
 * appear late simply join from their first observation, so the index never
 * jumps on a new listing.
 */
export function benchmarkIndex(bars: readonly TapeBarLike[]): IndexPoint[] {
  if (bars.length === 0) return [];
  const first: Record<string, number> = {};
  const out: IndexPoint[] = [];
  for (const bar of bars) {
    const ratios: number[] = [];
    for (const [sym, close] of Object.entries(bar.closes)) {
      if (!(close > 0)) continue;
      if (first[sym] === undefined) first[sym] = close;
      ratios.push(close / first[sym]!);
    }
    const value = ratios.length ? (ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100 : (out.at(-1)?.value ?? 100);
    out.push({ date: bar.date, value });
  }
  return out;
}

export type RegimeThresholds = {
  /** Trailing window, in bars, used for the trend read (default 63 ≈ 1 quarter). */
  lookback: number;
  /** Annualised trailing return above which the tape is bull, in % (default 10). */
  bullAnnualPct: number;
  /** Annualised trailing return below which the tape is bear, in % (default -10). */
  bearAnnualPct: number;
  /** Drawdown from the running peak that forces a bear label, in % (default 15). */
  bearDrawdownPct: number;
  /**
   * Annualised trend inside ±this band is chop regardless of sign, in %
   * (default 6). Stops a drifting-but-directionless tape being called bull.
   */
  sidewaysBandPct: number;
  /**
   * Peak-to-trough range of the trailing window below which the tape is
   * range-bound, in % of the window mean (default 8).
   */
  sidewaysRangePct: number;
  /**
   * Minimum R² of a log-linear fit over the trailing window before a
   * directional label is allowed (default 0.35). A high return with a
   * scattered path is chop, not a trend.
   */
  minTrendR2: number;
  /**
   * Drawdown depth that on its own marks a soft bear / distribution tape
   * when the trend read is not yet negative, in % (default 8).
   */
  sidewaysMaxDrawdownPct: number;
  /** Bars per year used to annualise (default 252). */
  barsPerYear: number;
};

export const DEFAULT_REGIME_THRESHOLDS: RegimeThresholds = {
  lookback: 63,
  bullAnnualPct: 10,
  bearAnnualPct: -10,
  bearDrawdownPct: 15,
  sidewaysBandPct: 6,
  sidewaysRangePct: 8,
  minTrendR2: 0.35,
  sidewaysMaxDrawdownPct: 8,
  barsPerYear: 252,
};

/** Annualised return implied by a start/end level over `bars` bars, in %. */
export function annualisedPct(startValue: number, endValue: number, bars: number, barsPerYear = 252): number {
  if (!(startValue > 0) || !(endValue > 0) || bars <= 0) return 0;
  const years = bars / barsPerYear;
  if (!(years > 0)) return 0;
  return ((endValue / startValue) ** (1 / years) - 1) * 100;
}

/**
 * R² of a least-squares fit of log(value) against bar number. 1 = a perfectly
 * smooth trend, 0 = a path with no linear structure at all (chop).
 */
export function trendR2(values: readonly number[]): number {
  const ys: number[] = [];
  for (const v of values) if (v > 0) ys.push(Math.log(v));
  const n = ys.length;
  if (n < 3) return 0;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    const dy = ys[i]! - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return 0;
  const r2 = (sxy * sxy) / (sxx * syy);
  return Math.min(1, Math.max(0, r2));
}

/** Peak-to-trough range of a window as a % of its mean level. */
export function rangeWidthPct(values: readonly number[]): number {
  const xs = values.filter((v) => v > 0);
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!(mean > 0)) return 0;
  return ((Math.max(...xs) - Math.min(...xs)) / mean) * 100;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Per-bar classification with the evidence behind it. */
export type RegimeBar = {
  index: number;
  date: string;
  label: RegimeLabel;
  /** 0..1 — how strongly the evidence supports the label. */
  confidence: number;
  /** Annualised trailing return, in %. */
  trendPct: number;
  /** R² of the trailing log-linear fit. */
  r2: number;
  /** Drawdown from the running peak, in % (<= 0). */
  drawdownPct: number;
  /** Trailing peak-to-trough range, in % of the window mean. */
  rangePct: number;
  /** Short human reason, useful when eyeballing coverage. */
  reason: string;
};

/**
 * Per-bar regime label plus confidence.
 *
 * Order of evidence:
 *   1. A deep drawdown from the running peak is bear whatever the trend says —
 *      a bounce inside a 20% drawdown is still a bear tape.
 *   2. A narrow trailing range, or a trend inside the ±`sidewaysBandPct` band,
 *      is sideways. This is the coverage fix: previously any drift at all fell
 *      through to bull/bear because there was no explicit chop test.
 *   3. A directional trend only earns bull/bear if the path is actually
 *      trending (R² >= `minTrendR2`); otherwise it is chop with a tilt.
 *   4. Everything else is sideways, with a soft-bear tilt in confidence when
 *      the tape is grinding below its peak by more than
 *      `sidewaysMaxDrawdownPct`.
 */
export function classifyRegimeBars(
  index: readonly IndexPoint[],
  thresholds: Partial<RegimeThresholds> = {},
): RegimeBar[] {
  const t = { ...DEFAULT_REGIME_THRESHOLDS, ...thresholds };
  if (t.lookback < 1) throw new Error("classifyRegimes: lookback must be >= 1");
  if (t.bearAnnualPct >= t.bullAnnualPct) {
    throw new Error("classifyRegimes: bearAnnualPct must be below bullAnnualPct");
  }
  if (t.sidewaysBandPct < 0) throw new Error("classifyRegimes: sidewaysBandPct must be >= 0");
  if (t.minTrendR2 < 0 || t.minTrendR2 > 1) {
    throw new Error("classifyRegimes: minTrendR2 must be between 0 and 1");
  }

  const out: RegimeBar[] = [];
  let peak = index[0]?.value ?? 0;
  for (let i = 0; i < index.length; i++) {
    const value = index[i]!.value;
    if (value > peak) peak = value;
    const drawdownPct = peak > 0 ? ((value - peak) / peak) * 100 : 0;
    const back = Math.min(i, t.lookback);
    const window = index.slice(i - back, i + 1).map((p) => p.value);
    const startValue = index[i - back]?.value ?? value;
    const trendPct = back > 0 ? annualisedPct(startValue, value, back, t.barsPerYear) : 0;
    const r2 = trendR2(window);
    const rangePct = rangeWidthPct(window);

    let label: RegimeLabel;
    let confidence: number;
    let reason: string;

    // The chop band can never swallow the directional thresholds themselves,
    // so a caller that lowers bullAnnualPct still gets bull labels.
    const band = Math.min(t.sidewaysBandPct, t.bullAnnualPct, Math.abs(t.bearAnnualPct));
    const bandwidth = Math.max(1, band);

    if (drawdownPct <= -t.bearDrawdownPct) {
      label = "bear";
      // Deeper than the trigger ⇒ more certain; twice the trigger pins it at 1.
      confidence = clamp01(0.6 + 0.4 * ((-drawdownPct - t.bearDrawdownPct) / t.bearDrawdownPct));
      reason = `drawdown ${drawdownPct.toFixed(1)}%`;
    } else if (trendPct >= t.bullAnnualPct && trendPct > band && r2 >= t.minTrendR2) {
      label = "bull";
      const strength = clamp01((trendPct - t.bullAnnualPct) / Math.max(1, Math.abs(t.bullAnnualPct)));
      confidence = clamp01(0.45 + 0.3 * strength + 0.25 * r2);
      reason = `trend +${trendPct.toFixed(1)}%, R² ${r2.toFixed(2)}`;
    } else if (trendPct <= t.bearAnnualPct && -trendPct > band && r2 >= t.minTrendR2) {
      label = "bear";
      const strength = clamp01((t.bearAnnualPct - trendPct) / Math.max(1, Math.abs(t.bearAnnualPct)));
      confidence = clamp01(0.45 + 0.3 * strength + 0.25 * r2);
      reason = `trend ${trendPct.toFixed(1)}%, R² ${r2.toFixed(2)}`;
    } else if (rangePct <= t.sidewaysRangePct && back >= 3) {
      label = "sideways";
      confidence = clamp01(0.6 + 0.4 * (1 - rangePct / Math.max(1e-9, t.sidewaysRangePct)));
      reason = `range ${rangePct.toFixed(1)}%`;
    } else if (Math.abs(trendPct) <= band) {
      label = "sideways";
      confidence = clamp01(0.5 + 0.5 * (1 - Math.abs(trendPct) / bandwidth));
      reason = `trend ${trendPct.toFixed(1)}% inside ±${band}% band`;
    } else {
      label = "sideways";
      // Directional in return but not in path: chop with a tilt. Weak
      // confidence, weaker still when it is grinding below the peak.
      const grinding = drawdownPct <= -t.sidewaysMaxDrawdownPct;
      confidence = clamp01((grinding ? 0.35 : 0.5) + 0.3 * (1 - r2));
      reason = grinding
        ? `choppy below peak (${drawdownPct.toFixed(1)}%), R² ${r2.toFixed(2)}`
        : `trend ${trendPct.toFixed(1)}% but R² only ${r2.toFixed(2)}`;
    }


    out.push({
      index: i,
      date: index[i]!.date,
      label,
      confidence,
      trendPct,
      r2,
      drawdownPct,
      rangePct,
      reason,
    });
  }
  return out;
}

/** Per-bar regime labels only — the thin wrapper around `classifyRegimeBars`. */
export function classifyRegimes(
  index: readonly IndexPoint[],
  thresholds: Partial<RegimeThresholds> = {},
): RegimeLabel[] {
  return classifyRegimeBars(index, thresholds).map((b) => b.label);
}


export type RegimeSegment = {
  label: RegimeLabel;
  startIndex: number;
  endIndex: number;
  from: string;
  to: string;
  bars: number;
};

/**
 * Collapse per-bar labels into contiguous segments, absorbing runs shorter
 * than `minBars` into the preceding segment so single-day flickers do not
 * shred the history into unusable slivers.
 */
export function segmentRegimes(
  index: readonly IndexPoint[],
  labels: readonly RegimeLabel[],
  minBars = 21,
): RegimeSegment[] {
  if (index.length !== labels.length) {
    throw new Error("segmentRegimes: index and labels must be the same length");
  }
  const raw: RegimeSegment[] = [];
  for (let i = 0; i < labels.length; i++) {
    const last = raw.at(-1);
    if (last && last.label === labels[i]) {
      last.endIndex = i;
      last.to = index[i]!.date;
      last.bars += 1;
    } else {
      raw.push({
        label: labels[i]!,
        startIndex: i,
        endIndex: i,
        from: index[i]!.date,
        to: index[i]!.date,
        bars: 1,
      });
    }
  }
  const merged: RegimeSegment[] = [];
  for (const seg of raw) {
    const prev = merged.at(-1);
    // A short run is absorbed into the preceding segment; so is any run
    // that ends up adjacent to a segment carrying the same label.
    if (prev && (seg.bars < minBars || prev.label === seg.label)) {
      prev.endIndex = seg.endIndex;
      prev.to = seg.to;
      prev.bars += seg.bars;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

export type WalkForwardWindow = {
  index: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
};

/**
 * Rolling train/test split. `trainBars` is in-sample context the strategy is
 * allowed to warm up on; `testBars` is the out-of-sample slice that is
 * actually scored. Windows advance by `step` (default: the test length, so
 * out-of-sample slices never overlap).
 */
export function walkForwardWindows(
  totalBars: number,
  opts: { trainBars: number; testBars: number; step?: number },
): WalkForwardWindow[] {
  const { trainBars, testBars } = opts;
  const step = opts.step ?? testBars;
  if (trainBars < 0) throw new Error("walkForwardWindows: trainBars must be >= 0");
  if (testBars < 1) throw new Error("walkForwardWindows: testBars must be >= 1");
  if (step < 1) throw new Error("walkForwardWindows: step must be >= 1");
  const out: WalkForwardWindow[] = [];
  for (let start = 0; start + trainBars + testBars <= totalBars; start += step) {
    out.push({
      index: out.length,
      trainStart: start,
      trainEnd: start + trainBars,
      testStart: start + trainBars,
      testEnd: start + trainBars + testBars,
    });
  }
  return out;
}

// ------------------------------------------------- overlapping sampling
//
// Non-overlapping windows are statistically clean but brutally sparse: ten
// years of daily bars with a 252/126 split yields ~18 out-of-sample slices,
// and bear/sideways regimes may pick up only two or three of them. Judging
// drawdown stability on three windows is judging noise.
//
// Overlapping windows fix the coverage problem at the cost of independence:
// neighbouring slices share bars, so their results are correlated and the
// raw window count overstates how much evidence you actually have. We
// therefore always report BOTH the raw count and an effective (independence-
// adjusted) count, and the gate is applied against the effective one.

/** Smallest step we will ever advance by, to avoid degenerate 1-bar shifts. */
export const MIN_OVERLAP_STEP_BARS = 5;

export type OverlapOptions = {
  trainBars: number;
  testBars: number;
  /** Explicit step in bars. Wins over `overlapPct` when provided. */
  step?: number;
  /** Fraction of each test slice shared with the next window, 0..0.95. */
  overlapPct?: number;
  /** Lower bound on the resolved step (default MIN_OVERLAP_STEP_BARS). */
  minStepBars?: number;
};

/** Resolve the bar step implied by an explicit step or an overlap fraction. */
export function resolveWalkForwardStep(opts: OverlapOptions): number {
  const { testBars } = opts;
  if (testBars < 1) throw new Error("resolveWalkForwardStep: testBars must be >= 1");
  const floor = Math.max(1, Math.floor(opts.minStepBars ?? MIN_OVERLAP_STEP_BARS));
  if (opts.step != null && Number.isFinite(opts.step)) {
    return Math.max(1, Math.floor(opts.step));
  }
  const overlap = Math.min(0.95, Math.max(0, Number(opts.overlapPct ?? 0)));
  if (!(overlap > 0)) return testBars;
  return Math.min(testBars, Math.max(Math.min(floor, testBars), Math.round(testBars * (1 - overlap))));
}

/**
 * Rolling windows with an overlap fraction instead of a raw step.
 * `overlapPct: 0` reproduces `walkForwardWindows` exactly.
 */
export function overlappingWalkForwardWindows(
  totalBars: number,
  opts: OverlapOptions,
): WalkForwardWindow[] {
  return walkForwardWindows(totalBars, {
    trainBars: opts.trainBars,
    testBars: opts.testBars,
    step: resolveWalkForwardStep(opts),
  });
}

/**
 * Independence-adjusted window count for a set of (possibly overlapping)
 * test slices: unique bars covered / mean slice length. Disjoint windows
 * return exactly their count; fully duplicated windows collapse toward 1.
 */
export function effectiveWindowCount(
  windows: readonly { testStart: number; testEnd: number }[],
): number {
  if (windows.length === 0) return 0;
  const sorted = [...windows].sort((a, b) => a.testStart - b.testStart);
  let uniqueBars = 0;
  let cursor = -Infinity;
  for (const w of sorted) {
    const start = Math.max(w.testStart, cursor);
    if (w.testEnd > start) uniqueBars += w.testEnd - start;
    cursor = Math.max(cursor, w.testEnd);
  }
  const meanLen =
    windows.reduce((sum, w) => sum + Math.max(0, w.testEnd - w.testStart), 0) / windows.length;
  if (!(meanLen > 0)) return 0;
  return uniqueBars / meanLen;
}

/** Mean pairwise overlap share across consecutive windows, 0..1. */
export function meanWindowOverlap(
  windows: readonly { testStart: number; testEnd: number }[],
): number {
  if (windows.length < 2) return 0;
  const sorted = [...windows].sort((a, b) => a.testStart - b.testStart);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const shared = Math.max(0, Math.min(prev.testEnd, cur.testEnd) - cur.testStart);
    const len = Math.max(1, cur.testEnd - cur.testStart);
    total += Math.min(1, shared / len);
  }
  return total / (sorted.length - 1);
}

// ------------------------------------------------- cross-validation draws

/** Deterministic 32-bit PRNG so a sampled run is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type CvSampleOptions = {
  /** Hard cap on how many windows are actually backtested. */
  maxWindows?: number;
  /** Cap per regime; prevents a bull-dominated tape swamping the sample. */
  perRegimeCap?: number;
  /** Minimum windows to keep per regime when supply allows. */
  minPerRegime?: number;
  /** Regimes to fill first when the cap binds (default bear, then sideways). */
  prioritise?: readonly RegimeLabel[];
  /** Seed for the deterministic thinning draw. */
  seed?: number;
};

export type CvSample<T> = {
  selected: T[];
  /** Windows available per regime before sampling. */
  available: Record<RegimeLabel, number>;
  /** Windows kept per regime. */
  kept: Record<RegimeLabel, number>;
  note: string;
};

const emptyCounts = (): Record<RegimeLabel, number> => ({ bull: 0, bear: 0, sideways: 0 });

/**
 * Regime-stratified thinning of a dense (overlapping) candidate set.
 *
 * With a large overlap the raw candidate list can run to hundreds of windows,
 * most of them bull. This keeps the scarce bear/sideways windows in full and
 * spreads the cut across the abundant regimes, so the sample the backtest
 * spends time on is the one that actually tests stability. Selection is
 * deterministic for a given seed and preserves chronological order.
 */
export function sampleRegimeBalancedWindows<T>(
  candidates: readonly T[],
  regimeOf: (item: T) => RegimeLabel,
  opts: CvSampleOptions = {},
): CvSample<T> {
  const available = emptyCounts();
  const byRegime: Record<RegimeLabel, T[]> = { bull: [], bear: [], sideways: [] };
  const order = new Map<T, number>();
  candidates.forEach((c, i) => {
    const r = regimeOf(c);
    byRegime[r].push(c);
    available[r] += 1;
    order.set(c, i);
  });

  const priority = opts.prioritise ?? (["bear", "sideways", "bull"] as const);
  const ranked = [...REGIMES].sort(
    (a, b) =>
      (priority.indexOf(a) < 0 ? 99 : priority.indexOf(a))
      - (priority.indexOf(b) < 0 ? 99 : priority.indexOf(b)),
  );

  const maxWindows = Math.max(0, Math.floor(opts.maxWindows ?? candidates.length));
  const perRegimeCap = Math.max(0, Math.floor(opts.perRegimeCap ?? candidates.length));
  const minPerRegime = Math.max(0, Math.floor(opts.minPerRegime ?? 0));
  const rand = mulberry32(Math.floor(opts.seed ?? 1));

  /** Evenly spaced thinning, jittered by the seed, keeping chronology. */
  const thin = (rows: readonly T[], keep: number): T[] => {
    if (keep >= rows.length) return [...rows];
    if (keep <= 0) return [];
    const stride = rows.length / keep;
    const picked = new Set<number>();
    for (let i = 0; i < keep; i++) {
      const base = i * stride;
      let idx = Math.floor(base + rand() * stride);
      idx = Math.min(rows.length - 1, Math.max(0, idx));
      while (picked.has(idx) && idx < rows.length) idx++;
      while (picked.has(idx) && idx > 0) idx--;
      picked.add(idx);
    }
    return [...picked].sort((a, b) => a - b).map((i) => rows[i]!);
  };

  const kept = emptyCounts();
  const chosen: T[] = [];
  let budget = maxWindows;

  // Pass 1 — guarantee the minimum for the scarce regimes first.
  if (minPerRegime > 0) {
    for (const regime of ranked) {
      const rows = byRegime[regime];
      const keep = Math.min(rows.length, minPerRegime, perRegimeCap, budget);
      const picked = thin(rows, keep);
      chosen.push(...picked);
      kept[regime] += picked.length;
      budget -= picked.length;
    }
  }

  // Pass 2 — share the remaining budget, still favouring scarce regimes.
  for (const regime of ranked) {
    if (budget <= 0) break;
    const rows = byRegime[regime].filter((r) => !chosen.includes(r));
    const room = Math.max(0, Math.min(perRegimeCap - kept[regime], rows.length, budget));
    if (room <= 0) continue;
    const picked = thin(rows, room);
    chosen.push(...picked);
    kept[regime] += picked.length;
    budget -= picked.length;
  }

  const selected = chosen.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const note =
    `sampled ${selected.length}/${candidates.length} windows `
    + `(bull ${kept.bull}/${available.bull}, bear ${kept.bear}/${available.bear}, `
    + `sideways ${kept.sideways}/${available.sideways})`;
  return { selected, available, kept, note };
}



/** Majority regime over a bar range; ties resolve bear > bull > sideways. */
export function dominantRegime(
  labels: readonly RegimeLabel[],
  start: number,
  end: number,
): { label: RegimeLabel; purity: number } {
  const slice = labels.slice(start, end);
  if (slice.length === 0) return { label: "sideways", purity: 0 };
  const counts: Record<RegimeLabel, number> = { bull: 0, bear: 0, sideways: 0 };
  for (const l of slice) counts[l] += 1;
  const order: RegimeLabel[] = ["bear", "bull", "sideways"];
  let best = order[0]!;
  for (const l of order) if (counts[l] > counts[best]) best = l;
  return { label: best, purity: counts[best] / slice.length };
}

export type DominantRegimeOptions = {
  /**
   * Weight each bar's vote by its confidence (default true), so a window of
   * hesitant bull bars loses to a smaller run of high-confidence chop.
   */
  weightByConfidence?: boolean;
  /**
   * Vote share a directional label must reach to hold; below this the window
   * is called sideways because the tape could not make up its mind
   * (default 0.45).
   */
  minDirectionalShare?: number;
  /**
   * Mean confidence a directional label must reach to hold (default 0.5).
   */
  minConfidence?: number;
};

export type DominantRegimeResult = {
  label: RegimeLabel;
  purity: number;
  /** Mean confidence of the bars carrying the winning label, 0..1. */
  confidence: number;
  /** Vote share per label over the range, confidence-weighted when enabled. */
  shares: Record<RegimeLabel, number>;
  /** True when a directional winner was demoted to sideways. */
  demoted: boolean;
};

/**
 * Confidence-weighted regime for a bar range. Unlike the plain majority vote
 * this demotes weak bull/bear wins to sideways, which is what makes the
 * walk-forward runner report real chop coverage rather than only extremes.
 */
export function dominantRegimeWeighted(
  bars: readonly RegimeBar[],
  start: number,
  end: number,
  opts: DominantRegimeOptions = {},
): DominantRegimeResult {
  const weighted = opts.weightByConfidence ?? true;
  const minShare = opts.minDirectionalShare ?? 0.45;
  const minConf = opts.minConfidence ?? 0.5;
  const slice = bars.slice(start, end);
  const empty: Record<RegimeLabel, number> = { bull: 0, bear: 0, sideways: 0 };
  if (slice.length === 0) {
    return { label: "sideways", purity: 0, confidence: 0, shares: { ...empty }, demoted: false };
  }

  const weight: Record<RegimeLabel, number> = { ...empty };
  const confSum: Record<RegimeLabel, number> = { ...empty };
  const count: Record<RegimeLabel, number> = { ...empty };
  for (const b of slice) {
    weight[b.label] += weighted ? Math.max(0.05, b.confidence) : 1;
    confSum[b.label] += b.confidence;
    count[b.label] += 1;
  }
  const total = weight.bull + weight.bear + weight.sideways;
  const shares: Record<RegimeLabel, number> = {
    bull: total > 0 ? weight.bull / total : 0,
    bear: total > 0 ? weight.bear / total : 0,
    sideways: total > 0 ? weight.sideways / total : 0,
  };

  const order: RegimeLabel[] = ["bear", "bull", "sideways"];
  let best = order[0]!;
  for (const l of order) if (weight[l] > weight[best]) best = l;

  const meanConf = (l: RegimeLabel) => (count[l] > 0 ? confSum[l] / count[l] : 0);
  let label = best;
  let demoted = false;
  if (best !== "sideways" && (shares[best] < minShare || meanConf(best) < minConf)) {
    label = "sideways";
    demoted = true;
  }

  return {
    label,
    purity: count[label] / slice.length,
    confidence: meanConf(label),
    shares,
    demoted,
  };
}

/** Share of bars falling in each regime — the coverage read for a tape. */
export function regimeCoverage(
  bars: readonly RegimeBar[],
): Record<RegimeLabel, { bars: number; share: number; meanConfidence: number }> {
  const out = {
    bull: { bars: 0, share: 0, meanConfidence: 0 },
    bear: { bars: 0, share: 0, meanConfidence: 0 },
    sideways: { bars: 0, share: 0, meanConfidence: 0 },
  } satisfies Record<RegimeLabel, { bars: number; share: number; meanConfidence: number }>;
  for (const b of bars) {
    out[b.label].bars += 1;
    out[b.label].meanConfidence += b.confidence;
  }
  for (const r of REGIMES) {
    const n = out[r].bars;
    out[r].share = bars.length ? n / bars.length : 0;
    out[r].meanConfidence = n ? out[r].meanConfidence / n : 0;
  }
  return out;
}


// ------------------------------------------------------------- scoring

/** Net CAGR of an equity curve over `bars` bars, in %. */
export function curveCagrPct(curve: readonly EquityPoint[], barsPerYear = 252): number {
  if (curve.length < 2) return 0;
  return annualisedPct(
    curve[0]!.total_value,
    curve.at(-1)!.total_value,
    curve.length - 1,
    barsPerYear,
  );
}

/** Max drawdown of an equity curve as a negative percentage. */
export function curveMaxDrawdownPct(curve: readonly EquityPoint[]): number {
  let peak = curve[0]?.total_value ?? 0;
  let worst = 0;
  for (const p of curve) {
    if (p.total_value > peak) peak = p.total_value;
    const dd = peak > 0 ? ((p.total_value - peak) / peak) * 100 : 0;
    if (dd < worst) worst = dd;
  }
  return worst;
}

export type WindowResult = {
  window: WalkForwardWindow;
  regime: RegimeLabel;
  purity: number;
  /** Mean confidence of the winning label over the window, 0..1. */
  confidence?: number;
  /** True when a weak directional read was demoted to sideways. */
  demoted?: boolean;

  from: string;
  to: string;
  netCagrPct: number;
  maxDrawdownPct: number;
  benchmarkCagrPct: number;
  trades: number;
  tradesPerYear: number;
  feeDragPct: number;
  sharpe: number;
  /**
   * Train vs out-of-sample cost decomposition for this window. Optional so
   * hand-built rows and older callers still typecheck; the runner populates
   * it and the cost report aggregates it per regime. Imported type-only, so
   * the pairing with `regime-cost-attribution` costs no runtime cycle.
   */
  costs?: WindowCosts;
};



export type RegimeSummary = {
  regime: RegimeLabel;
  windows: number;
  bars: number;
  medianNetCagrPct: number;
  meanNetCagrPct: number;
  worstNetCagrPct: number;
  bestNetCagrPct: number;
  /** Standard deviation of window CAGR — lower is more stable. */
  cagrStdPct: number;
  medianMaxDrawdownPct: number;
  worstMaxDrawdownPct: number;
  medianBenchmarkCagrPct: number;
  /** Share of windows with a positive net CAGR. */
  positiveRate: number;
  /** Share of windows beating the benchmark. */
  beatBenchmarkRate: number;
  /** Mean regime confidence across the windows in this regime, 0..1. */
  meanConfidence: number;
  medianTradesPerYear: number;
  /**
   * Independence-adjusted window count. Equals `windows` for disjoint slices
   * and shrinks as overlap rises, so an overlapping run cannot fake evidence.
   */
  effectiveWindows: number;
  /** Mean overlap share between consecutive windows in this regime, 0..1. */
  overlapShare: number;

  /** True when every window respected the drawdown ceiling. */
  drawdownStable: boolean;
  /** True when the regime has enough independent evidence to judge. */
  sufficientEvidence: boolean;
  /** True when the regime is profitable and drawdown-stable throughout. */
  pass: boolean;
};


export function median(values: readonly number[]): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

export function stdev(values: readonly number[]): number {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

export type RegimeGate = {
  /** Drawdown ceiling as a positive magnitude, in % (default 25). */
  maxDrawdownPct: number;
  /** Median net CAGR a regime must clear, in % (default 0). */
  minMedianCagrPct: number;
  /** Share of windows that must be profitable (default 0.5). */
  minPositiveRate: number;
  /**
   * Independent-window evidence a regime needs before its verdict counts
   * (default 0 = no requirement). Applied to `effectiveWindows`, not the raw
   * count, so overlapping slices cannot buy a pass.
   */
  minEffectiveWindows: number;
};

export const DEFAULT_REGIME_GATE: RegimeGate = {
  maxDrawdownPct: 25,
  minMedianCagrPct: 0,
  minPositiveRate: 0.5,
  minEffectiveWindows: 0,
};

/** Aggregate the out-of-sample windows that fell in one regime. */
export function summariseRegime(
  regime: RegimeLabel,
  results: readonly WindowResult[],
  gate: Partial<RegimeGate> = {},
): RegimeSummary {
  const g = { ...DEFAULT_REGIME_GATE, ...gate };
  const rows = results.filter((r) => r.regime === regime);
  if (rows.length === 0) {
    return {
      regime,
      windows: 0,
      bars: 0,
      medianNetCagrPct: 0,
      meanNetCagrPct: 0,
      worstNetCagrPct: 0,
      bestNetCagrPct: 0,
      cagrStdPct: 0,
      medianMaxDrawdownPct: 0,
      worstMaxDrawdownPct: 0,
      medianBenchmarkCagrPct: 0,
      positiveRate: 0,
      beatBenchmarkRate: 0,
      meanConfidence: 0,
      medianTradesPerYear: 0,
      effectiveWindows: 0,
      overlapShare: 0,

      drawdownStable: true,
      sufficientEvidence: false,
      pass: false,
    };
  }
  const cagrs = rows.map((r) => r.netCagrPct);
  const dds = rows.map((r) => -Math.abs(r.maxDrawdownPct));
  const positiveRate = cagrs.filter((c) => c > 0).length / rows.length;
  const drawdownStable = dds.every((d) => Math.abs(d) <= g.maxDrawdownPct + 1e-9);
  const medianNetCagrPct = median(cagrs);
  // Overlapping windows share bars, so `windows` overstates the evidence.
  const slices = rows.map((r) => r.window);
  const effectiveWindows = effectiveWindowCount(slices);
  const sufficientEvidence = effectiveWindows >= g.minEffectiveWindows - 1e-9;
  return {
    regime,
    windows: rows.length,
    bars: rows.reduce((sum, r) => sum + (r.window.testEnd - r.window.testStart), 0),
    medianNetCagrPct,
    meanNetCagrPct: cagrs.reduce((a, b) => a + b, 0) / rows.length,
    worstNetCagrPct: Math.min(...cagrs),
    bestNetCagrPct: Math.max(...cagrs),
    cagrStdPct: stdev(cagrs),
    medianMaxDrawdownPct: median(dds),
    worstMaxDrawdownPct: Math.min(...dds),
    medianBenchmarkCagrPct: median(rows.map((r) => r.benchmarkCagrPct)),
    positiveRate,
    beatBenchmarkRate: rows.filter((r) => r.netCagrPct > r.benchmarkCagrPct).length / rows.length,
    meanConfidence:
      rows.reduce((a, r) => a + (Number.isFinite(r.confidence ?? NaN) ? r.confidence! : 0), 0)
      / rows.length,
    medianTradesPerYear: median(rows.map((r) => r.tradesPerYear)),
    effectiveWindows,
    overlapShare: meanWindowOverlap(slices),

    drawdownStable,
    sufficientEvidence,
    pass:
      drawdownStable
      && sufficientEvidence
      && medianNetCagrPct >= g.minMedianCagrPct - 1e-9
      && positiveRate >= g.minPositiveRate - 1e-9,
  };
}


export type RegimeReport = {
  summaries: RegimeSummary[];
  /** Regimes with at least one out-of-sample window. */
  covered: RegimeLabel[];
  /** Regimes that failed the gate. */
  failed: RegimeLabel[];
  /** Spread between the best and worst regime median CAGR, in points. */
  cagrDispersionPct: number;
  /** Worst drawdown seen in any window, any regime. */
  worstDrawdownPct: number;
  verdict: "stable" | "regime-dependent" | "unstable";
};

export function buildRegimeReport(
  results: readonly WindowResult[],
  gate: Partial<RegimeGate> = {},
): RegimeReport {
  const summaries = REGIMES.map((r) => summariseRegime(r, results, gate));
  const covered = summaries.filter((s) => s.windows > 0).map((s) => s.regime);
  const scored = summaries.filter((s) => s.windows > 0);
  const failed = scored.filter((s) => !s.pass).map((s) => s.regime);
  const medians = scored.map((s) => s.medianNetCagrPct);
  const dispersion = medians.length ? Math.max(...medians) - Math.min(...medians) : 0;
  const worstDrawdownPct = results.length
    ? Math.min(...results.map((r) => -Math.abs(r.maxDrawdownPct)))
    : 0;
  const verdict: RegimeReport["verdict"] =
    failed.length === 0 ? "stable" : failed.length < scored.length ? "regime-dependent" : "unstable";
  return { summaries, covered, failed, cagrDispersionPct: dispersion, worstDrawdownPct, verdict };
}

// ---------------------------------------------------------------- output

export const REGIME_COLUMNS = [
  "regime",
  "windows",
  "eff. windows",
  "overlap",
  "median CAGR %",
  "worst CAGR %",
  "CAGR sd",
  "median maxDD %",
  "worst maxDD %",
  "bench CAGR %",
  "profitable",
  "beat B&H",
  "trades/yr",
  "confidence",

  "result",
] as const;

export const WINDOW_COLUMNS = [
  "#",
  "from",
  "to",
  "regime",
  "purity",
  "conf",

  "net CAGR %",
  "maxDD %",
  "bench CAGR %",
  "trades/yr",
  "fees %",
] as const;

const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
const pctOf = (v: number) => `${Math.round(v * 100)}%`;

export function regimeTableRows(summaries: readonly RegimeSummary[]): string[][] {
  return summaries.map((s) => [
    s.regime,
    String(s.windows),
    f(s.effectiveWindows),
    pctOf(s.overlapShare),
    f(s.medianNetCagrPct),
    f(s.worstNetCagrPct),
    f(s.cagrStdPct),
    f(s.medianMaxDrawdownPct),
    f(s.worstMaxDrawdownPct),
    f(s.medianBenchmarkCagrPct),
    pctOf(s.positiveRate),
    pctOf(s.beatBenchmarkRate),
    f(s.medianTradesPerYear, 0),
    pctOf(s.meanConfidence),

    s.windows === 0
      ? "no data"
      : !s.sufficientEvidence
        ? "too few independent windows"
        : s.pass
          ? "pass"
          : s.drawdownStable
            ? "weak returns"
            : "drawdown breach",
  ]);
}


export function windowTableRows(results: readonly WindowResult[]): string[][] {
  return results.map((r) => [
    String(r.window.index),
    r.from,
    r.to,
    r.regime,
    pctOf(r.purity),
    pctOf(r.confidence ?? 0),

    f(r.netCagrPct),
    f(-Math.abs(r.maxDrawdownPct)),
    f(r.benchmarkCagrPct),
    f(r.tradesPerYear, 0),
    f(r.feeDragPct),
  ]);
}

function pad(rows: readonly string[][], columns: readonly string[]): string {
  const all = [[...columns], ...rows];
  const widths = columns.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) => r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ")).join("\n");
}

export function formatRegimeTable(summaries: readonly RegimeSummary[]): string {
  return pad(regimeTableRows(summaries), REGIME_COLUMNS);
}

export function formatWindowTable(results: readonly WindowResult[]): string {
  return pad(windowTableRows(results), WINDOW_COLUMNS);
}

export function summariseReport(report: RegimeReport, gate: Partial<RegimeGate> = {}): string {
  const g = { ...DEFAULT_REGIME_GATE, ...gate };
  const head = `Regime verdict: ${report.verdict}`;
  const cover = ` — covered ${report.covered.join(", ") || "nothing"}`;
  const fail = report.failed.length ? `; failed in ${report.failed.join(", ")}` : "; all regimes pass";
  const nums =
    `; median CAGR spread ${f(report.cagrDispersionPct)}pts, ` +
    `worst drawdown ${f(report.worstDrawdownPct)}% against a -${g.maxDrawdownPct}% ceiling`;
  return head + cover + fail + nums;
}
