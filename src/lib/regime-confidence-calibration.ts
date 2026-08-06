// Confidence calibration for the walk-forward regime tagger.
//
// `classifyRegimeBars` emits a heuristic 0..1 confidence per bar. That number is
// an evidence score, not a probability: a bar labelled "bull" with confidence
// 0.8 has no guarantee of being right 80% of the time. This module closes that
// gap empirically:
//
//   1. Score each bar against what the tape actually did next (the realized
//      regime over a forward horizon) → (confidence, correct) samples.
//   2. Measure how far stated confidence sits from observed accuracy
//      (reliability bins, ECE, MCE, Brier).
//   3. Fit a monotone isotonic (pool-adjacent-violators) map from stated
//      confidence to observed accuracy, and re-emit the bars through it.
//
// Everything here is pure and deterministic — no clock, no I/O — so the same
// tape always yields the same calibrator.

import type { IndexPoint, RegimeBar, RegimeLabel } from "./regime-walk-forward";

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type RealizedOptions = {
  /** Bars to look ahead when deciding what actually happened. */
  horizonBars: number;
  /** |forward move| below this (in %) counts as sideways. */
  bandPct: number;
};

export const DEFAULT_REALIZED_OPTIONS: RealizedOptions = {
  horizonBars: 21,
  bandPct: 3,
};

/**
 * What the tape actually did over the next `horizonBars` bars, expressed with
 * the same vocabulary as the classifier. Returns null when the horizon runs
 * past the end of the series (those bars cannot be scored).
 */
export function realizedRegime(
  index: readonly IndexPoint[],
  i: number,
  opts: Partial<RealizedOptions> = {},
): { label: RegimeLabel; forwardPct: number } | null {
  const o = { ...DEFAULT_REALIZED_OPTIONS, ...opts };
  if (o.horizonBars < 1) throw new Error("realizedRegime: horizonBars must be >= 1");
  if (o.bandPct < 0) throw new Error("realizedRegime: bandPct must be >= 0");
  const from = index[i]?.value;
  const to = index[i + o.horizonBars]?.value;
  if (!(typeof from === "number") || !(typeof to === "number")) return null;
  if (!(from > 0) || !Number.isFinite(to)) return null;
  const forwardPct = ((to - from) / from) * 100;
  const label: RegimeLabel =
    forwardPct >= o.bandPct ? "bull" : forwardPct <= -o.bandPct ? "bear" : "sideways";
  return { label, forwardPct };
}

export type CalibrationSample = {
  index: number;
  date: string;
  stated: number;
  label: RegimeLabel;
  realized: RegimeLabel;
  correct: boolean;
  forwardPct: number;
};

/** Pair every scoreable bar with the regime that actually followed it. */
export function buildRegimeSamples(
  bars: readonly RegimeBar[],
  index: readonly IndexPoint[],
  opts: Partial<RealizedOptions> = {},
): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (const bar of bars) {
    const realized = realizedRegime(index, bar.index, opts);
    if (!realized) continue;
    out.push({
      index: bar.index,
      date: bar.date,
      stated: clamp01(bar.confidence),
      label: bar.label,
      realized: realized.label,
      correct: bar.label === realized.label,
      forwardPct: realized.forwardPct,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reliability
// ---------------------------------------------------------------------------

export const DEFAULT_BIN_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1.0000001] as const;

export type ReliabilityBin = {
  lower: number;
  upper: number;
  label: string;
  n: number;
  meanStated: number | null;
  accuracy: number | null;
  /** accuracy − meanStated: negative = overconfident, positive = underconfident. */
  gap: number | null;
};

export type ReliabilityReport = {
  bins: ReliabilityBin[];
  n: number;
  accuracy: number | null;
  meanStated: number | null;
  /** Sample-weighted mean |accuracy − stated| across populated bins. */
  ece: number | null;
  /** Worst populated-bin |accuracy − stated|. */
  mce: number | null;
  /** Mean squared error of the stated confidence against the 0/1 outcome. */
  brier: number | null;
  verdict: "well-calibrated" | "overconfident" | "underconfident" | "unknown";
};

const pctLabel = (v: number) => `${Math.round(v * 100)}%`;

/** Bucket samples by stated confidence and compare each bucket to its hit-rate. */
export function reliabilityReport(
  samples: readonly CalibrationSample[],
  edges: readonly number[] = DEFAULT_BIN_EDGES,
): ReliabilityReport {
  if (edges.length < 2) throw new Error("reliabilityReport: need at least two bin edges");
  const bins: ReliabilityBin[] = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const lower = edges[b]!;
    const upper = edges[b + 1]!;
    const inBin = samples.filter((s) => s.stated >= lower && s.stated < upper);
    const n = inBin.length;
    const meanStated = n ? inBin.reduce((a, s) => a + s.stated, 0) / n : null;
    const accuracy = n ? inBin.filter((s) => s.correct).length / n : null;
    bins.push({
      lower,
      upper,
      label: `${pctLabel(lower)}–${pctLabel(Math.min(1, upper))}`,
      n,
      meanStated,
      accuracy,
      gap: n && meanStated !== null && accuracy !== null ? accuracy - meanStated : null,
    });
  }

  const n = samples.length;
  if (!n) {
    return { bins, n: 0, accuracy: null, meanStated: null, ece: null, mce: null, brier: null, verdict: "unknown" };
  }

  const accuracy = samples.filter((s) => s.correct).length / n;
  const meanStated = samples.reduce((a, s) => a + s.stated, 0) / n;
  const brier = samples.reduce((a, s) => a + (s.stated - (s.correct ? 1 : 0)) ** 2, 0) / n;

  let ece = 0;
  let mce = 0;
  for (const bin of bins) {
    if (!bin.n || bin.gap === null) continue;
    const gap = Math.abs(bin.gap);
    ece += (bin.n / n) * gap;
    if (gap > mce) mce = gap;
  }

  const drift = accuracy - meanStated;
  const verdict =
    Math.abs(drift) <= 0.05 ? "well-calibrated" : drift < 0 ? "overconfident" : "underconfident";

  return { bins, n, accuracy, meanStated, ece, mce, brier, verdict };
}

// ---------------------------------------------------------------------------
// Isotonic fit (pool adjacent violators)
// ---------------------------------------------------------------------------

export type CalibrationKnot = { x: number; y: number };

export type ConfidenceCalibrator = {
  /** Monotone non-decreasing knots mapping stated confidence → observed accuracy. */
  knots: CalibrationKnot[];
  /** Samples the fit was built from. */
  n: number;
  /** true when the map is the identity (not enough data to fit). */
  identity: boolean;
  /** Map a stated confidence onto the empirically observed accuracy. */
  calibrate: (stated: number) => number;
};

export const MIN_CALIBRATION_SAMPLES = 20;

/** Pool-adjacent-violators: the smallest monotone fit in least squares. */
function pav(points: readonly { x: number; y: number; w: number }[]): CalibrationKnot[] {
  const blocks: { x: number; y: number; w: number }[] = [];
  for (const p of points) {
    let cur = { x: p.x, y: p.y, w: p.w };
    while (blocks.length && blocks[blocks.length - 1]!.y > cur.y) {
      const prev = blocks.pop()!;
      const w = prev.w + cur.w;
      cur = { x: (prev.x * prev.w + cur.x * cur.w) / w, y: (prev.y * prev.w + cur.y * cur.w) / w, w };
    }
    blocks.push(cur);
  }
  return blocks.map((b) => ({ x: clamp01(b.x), y: clamp01(b.y) }));
}

function interpolate(knots: readonly CalibrationKnot[], x: number): number {
  if (!knots.length) return clamp01(x);
  const v = clamp01(x);
  if (v <= knots[0]!.x) return knots[0]!.y;
  const last = knots[knots.length - 1]!;
  if (v >= last.x) return last.y;
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1]!;
    const b = knots[i]!;
    if (v <= b.x) {
      const span = b.x - a.x;
      if (!(span > 0)) return b.y;
      return clamp01(a.y + ((v - a.x) / span) * (b.y - a.y));
    }
  }
  return last.y;
}

export const identityCalibrator = (n = 0): ConfidenceCalibrator => ({
  knots: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  n,
  identity: true,
  calibrate: clamp01,
});

/**
 * Fit stated confidence → observed accuracy. Falls back to the identity map
 * below `MIN_CALIBRATION_SAMPLES`, so a thin tape never invents a curve.
 */
export function fitConfidenceCalibrator(
  samples: readonly CalibrationSample[],
  minSamples = MIN_CALIBRATION_SAMPLES,
): ConfidenceCalibrator {
  if (samples.length < Math.max(1, minSamples)) return identityCalibrator(samples.length);
  // Pool identical stated values first: ties must share one block, otherwise
  // the fit interpolates between halves of the same cohort.
  const grouped = new Map<number, { hits: number; n: number }>();
  for (const s of samples) {
    const g = grouped.get(s.stated) ?? { hits: 0, n: 0 };
    g.hits += s.correct ? 1 : 0;
    g.n += 1;
    grouped.set(s.stated, g);
  }
  const points = [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, g]) => ({ x, y: g.hits / g.n, w: g.n }));
  const knots = pav(points);
  const calibrator: ConfidenceCalibrator = {
    knots,
    n: samples.length,
    identity: false,
    calibrate: (stated: number) => interpolate(knots, stated),
  };
  return calibrator;
}

// ---------------------------------------------------------------------------
// End-to-end
// ---------------------------------------------------------------------------

export type CalibratedRegimeBar = RegimeBar & {
  /** The original heuristic evidence score. */
  statedConfidence: number;
  /** Empirically observed accuracy for bars that looked like this one. */
  calibratedConfidence: number;
};

/** Re-emit bars with `confidence` replaced by its calibrated counterpart. */
export function applyCalibration(
  bars: readonly RegimeBar[],
  calibrator: ConfidenceCalibrator,
): CalibratedRegimeBar[] {
  return bars.map((bar) => {
    const stated = clamp01(bar.confidence);
    const calibrated = clamp01(calibrator.calibrate(stated));
    return { ...bar, confidence: calibrated, statedConfidence: stated, calibratedConfidence: calibrated };
  });
}

export type RegimeCalibrationResult = {
  calibrator: ConfidenceCalibrator;
  samples: CalibrationSample[];
  /** Reliability of the raw heuristic confidence. */
  before: ReliabilityReport;
  /** Reliability after pushing the same samples through the fitted map. */
  after: ReliabilityReport;
  bars: CalibratedRegimeBar[];
  horizonBars: number;
};

/**
 * One call: score the bars against the tape, fit the map, and hand back both
 * the calibrated bars and the before/after reliability so the improvement is
 * auditable rather than asserted.
 */
export function calibrateRegimeConfidence(
  bars: readonly RegimeBar[],
  index: readonly IndexPoint[],
  opts: Partial<RealizedOptions> & { minSamples?: number; edges?: readonly number[] } = {},
): RegimeCalibrationResult {
  const o = { ...DEFAULT_REALIZED_OPTIONS, ...opts };
  const samples = buildRegimeSamples(bars, index, o);
  const calibrator = fitConfidenceCalibrator(samples, opts.minSamples ?? MIN_CALIBRATION_SAMPLES);
  const edges = opts.edges ?? DEFAULT_BIN_EDGES;
  const before = reliabilityReport(samples, edges);
  const after = reliabilityReport(
    samples.map((s) => ({ ...s, stated: clamp01(calibrator.calibrate(s.stated)) })),
    edges,
  );
  return {
    calibrator,
    samples,
    before,
    after,
    bars: applyCalibration(bars, calibrator),
    horizonBars: o.horizonBars,
  };
}
