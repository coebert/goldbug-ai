// Final rolling holdout.
//
// Walk-forward already scores each fold out of sample, but the *choice* of
// window lengths, objective, candidate grid and search budget is still tuned by
// looking at those folds. After enough iterations the walk-forward OOS curve
// quietly becomes an in-sample artefact of the research process itself.
//
// The fix is a slice of tape the research loop is never allowed to touch: a
// final holdout at the end of history, carved off BEFORE folds are built. Once
// the strategy is frozen it is run once over that holdout, in consecutive
// rolling segments, and the segments are compared with what walk-forward
// promised. Agreement is evidence of genuine stability; a collapse means the
// pipeline was fitting the research process.
//
// Pure module: no I/O, no clock, no randomness.

import {
  buildWalkForwardFolds,
  type BuildFoldsOptions,
  type FoldMetrics,
  type WalkForwardFold,
  type WalkForwardSummary,
} from "./walk-forward";

export type DateWindow = { from: string; to: string };

function addDaysISO(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stdDev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1));
}

function compound(pcts: readonly number[]): number {
  let acc = 1;
  for (const p of pcts) acc *= 1 + p / 100;
  return (acc - 1) * 100;
}

const round = (n: number, dp = 2) => Number(n.toFixed(dp));

// ---------------------------------------------------------------------------
// Carving the holdout
// ---------------------------------------------------------------------------

export type HoldoutSplit = {
  /** The slice walk-forward is allowed to train and score on. */
  trainable: DateWindow;
  /** The untouched tail, or null when history is too short to spare one. */
  holdout: DateWindow | null;
  /** Consecutive equal-length segments tiling the holdout, oldest first. */
  segments: DateWindow[];
  /** Why a holdout could not be carved, when `holdout` is null. */
  note?: string;
};

export type HoldoutSplitOptions = {
  from: string;
  to: string;
  /** Calendar days reserved at the end of history. */
  holdoutDays: number;
  /** Length of each rolling holdout segment (default: 1/3 of the holdout). */
  segmentDays?: number;
  /** Refuse to carve a holdout if fewer than this many days would remain. */
  minTrainableDays?: number;
};

/**
 * Reserve the last `holdoutDays` of the range and tile it with rolling
 * segments. The trainable window ends the day before the holdout starts, so no
 * training or fold-scoring bar can ever leak into it.
 */
export function splitHoldout(opts: HoldoutSplitOptions): HoldoutSplit {
  const { from, to } = opts;
  const holdoutDays = Math.max(0, Math.floor(opts.holdoutDays));
  const minTrainable = Math.max(1, Math.floor(opts.minTrainableDays ?? 180));
  const whole: DateWindow = { from, to };

  if (!(to > from)) {
    return { trainable: whole, holdout: null, segments: [], note: "Range is empty." };
  }
  const totalDays = daysBetween(from, to) + 1;
  if (holdoutDays <= 0) {
    return { trainable: whole, holdout: null, segments: [], note: "No holdout requested." };
  }
  if (totalDays - holdoutDays < minTrainable) {
    return {
      trainable: whole,
      holdout: null,
      segments: [],
      note: `Need ${minTrainable + holdoutDays} days to reserve a ${holdoutDays}-day holdout; only ${totalDays} available.`,
    };
  }

  const holdoutFrom = addDaysISO(to, -(holdoutDays - 1));
  const holdout: DateWindow = { from: holdoutFrom, to };
  const trainable: DateWindow = { from, to: addDaysISO(holdoutFrom, -1) };

  const segmentDays = Math.max(1, Math.floor(opts.segmentDays ?? Math.floor(holdoutDays / 3) || holdoutDays));
  const segments: DateWindow[] = [];
  let cursor = holdoutFrom;
  while (cursor <= to) {
    const end = addDaysISO(cursor, segmentDays - 1);
    if (end > to) {
      // Fold a short tail into the last full segment rather than scoring a
      // stub window whose annualised numbers would be meaningless.
      if (segments.length === 0) segments.push({ from: cursor, to });
      else segments[segments.length - 1]!.to = to;
      break;
    }
    segments.push({ from: cursor, to: end });
    cursor = addDaysISO(end, 1);
  }

  return { trainable, holdout, segments };
}

export type FoldsWithHoldout = {
  folds: WalkForwardFold[];
  split: HoldoutSplit;
};

/**
 * Build walk-forward folds over the trainable slice only. Any fold that would
 * touch the holdout is dropped, so `folds` and `split.holdout` are disjoint by
 * construction.
 */
export function buildFoldsWithHoldout(
  opts: BuildFoldsOptions & { holdoutDays: number; segmentDays?: number; minTrainableDays?: number },
): FoldsWithHoldout {
  const split = splitHoldout({
    from: opts.from,
    to: opts.to,
    holdoutDays: opts.holdoutDays,
    ...(opts.segmentDays === undefined ? {} : { segmentDays: opts.segmentDays }),
    ...(opts.minTrainableDays === undefined ? {} : { minTrainableDays: opts.minTrainableDays }),
  });
  const folds = buildWalkForwardFolds({ ...opts, to: split.trainable.to });
  const cutoff = split.holdout?.from;
  const clean = cutoff ? folds.filter((f) => f.test.to < cutoff) : folds;
  return { folds: clean, split };
}

// ---------------------------------------------------------------------------
// Scoring the holdout
// ---------------------------------------------------------------------------

export type HoldoutSegmentResult = {
  index: number;
  window: DateWindow;
  metrics: FoldMetrics;
  benchmark?: FoldMetrics | null;
};

export type HoldoutVerdict = "confirmed" | "weakened" | "broken" | "insufficient";

export type HoldoutAssessment = {
  segments: number;
  window: DateWindow | null;
  /** Compounded return across the holdout segments, in %. */
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  /** Share of holdout segments with a positive return, 0..1. */
  segmentHitRate: number;
  /** Spread of segment Sharpe — high means the edge is not stable. */
  sharpeDispersion: number;
  /** Walk-forward OOS Sharpe minus holdout Sharpe. Positive = decay. */
  sharpeDecay: number;
  /** Walk-forward OOS CAGR minus holdout CAGR, in percentage points. */
  cagrDecay: number;
  /**
   * Holdout Sharpe as a share of the walk-forward OOS Sharpe. 1 means the
   * holdout reproduced walk-forward exactly; below 0.5 means it halved.
   */
  retention: number | null;
  benchmarkReturnPct: number | null;
  excessReturnPct: number | null;
  verdict: HoldoutVerdict;
  reasons: string[];
  sentence: string;
};

export const MIN_HOLDOUT_SEGMENTS = 2;

const EMPTY_ASSESSMENT = (note: string): HoldoutAssessment => ({
  segments: 0,
  window: null,
  totalReturnPct: 0,
  cagrPct: 0,
  maxDrawdownPct: 0,
  sharpe: 0,
  segmentHitRate: 0,
  sharpeDispersion: 0,
  sharpeDecay: 0,
  cagrDecay: 0,
  retention: null,
  benchmarkReturnPct: null,
  excessReturnPct: null,
  verdict: "insufficient",
  reasons: [note],
  sentence: note,
});

/**
 * Compare the frozen strategy's holdout behaviour with what walk-forward
 * promised. `walkForward` supplies the expectation; the holdout supplies the
 * unseen tape.
 */
export function assessHoldout(
  segments: readonly HoldoutSegmentResult[],
  walkForward: Pick<WalkForwardSummary, "oosSharpe" | "oosCagrPct"> | null,
): HoldoutAssessment {
  if (segments.length === 0) return EMPTY_ASSESSMENT("No holdout segments were scored.");
  if (segments.length < MIN_HOLDOUT_SEGMENTS) {
    return {
      ...EMPTY_ASSESSMENT(
        `Only ${segments.length} holdout segment — need ${MIN_HOLDOUT_SEGMENTS} to judge stability.`,
      ),
      segments: segments.length,
      window: { from: segments[0]!.window.from, to: segments[segments.length - 1]!.window.to },
    };
  }

  const ordered = [...segments].sort((a, b) => a.index - b.index);
  const returns = ordered.map((s) => s.metrics.totalReturnPct);
  const totalReturnPct = compound(returns);
  const days = ordered.reduce((s, x) => s + Math.max(1, x.metrics.days), 0);
  const years = Math.max(0.05, days / 252);
  const cagrPct = (Math.pow(1 + totalReturnPct / 100, 1 / years) - 1) * 100;
  const maxDrawdownPct = Math.min(...ordered.map((s) => s.metrics.maxDrawdownPct));
  const sharpes = ordered.map((s) => s.metrics.sharpe);
  const sharpe = mean(sharpes);
  const segmentHitRate = ordered.filter((s) => s.metrics.totalReturnPct > 0).length / ordered.length;
  const sharpeDispersion = stdDev(sharpes);

  const hasBench = ordered.every((s) => s.benchmark != null);
  const benchmarkReturnPct = hasBench
    ? compound(ordered.map((s) => (s.benchmark as FoldMetrics).totalReturnPct))
    : null;

  const sharpeDecay = walkForward ? walkForward.oosSharpe - sharpe : 0;
  const cagrDecay = walkForward ? walkForward.oosCagrPct - cagrPct : 0;
  const retention =
    walkForward && Math.abs(walkForward.oosSharpe) > 1e-9 ? sharpe / walkForward.oosSharpe : null;

  const reasons: string[] = [];
  if (sharpe < 0) reasons.push(`Holdout Sharpe ${sharpe.toFixed(2)} is negative on unseen tape.`);
  if (segmentHitRate < 0.5)
    reasons.push(`Only ${Math.round(segmentHitRate * 100)}% of holdout segments were profitable.`);
  if (retention != null && retention < 0.5)
    reasons.push(
      `Holdout kept just ${Math.round(retention * 100)}% of the walk-forward Sharpe — the edge decayed.`,
    );
  if (sharpeDispersion > 1)
    reasons.push(`Segment Sharpe swings widely (sd ${sharpeDispersion.toFixed(2)}).`);
  if (maxDrawdownPct < -25)
    reasons.push(`Worst holdout drawdown ${maxDrawdownPct.toFixed(1)}% exceeds 25%.`);
  if (benchmarkReturnPct != null && totalReturnPct < benchmarkReturnPct)
    reasons.push(
      `Trailed the benchmark on holdout (${totalReturnPct.toFixed(1)}% vs ${benchmarkReturnPct.toFixed(1)}%).`,
    );

  const broken =
    sharpe < 0 ||
    segmentHitRate < 0.34 ||
    (retention != null && retention < 0.25) ||
    maxDrawdownPct < -35;
  const verdict: HoldoutVerdict = broken ? "broken" : reasons.length === 0 ? "confirmed" : "weakened";
  if (reasons.length === 0)
    reasons.push("Holdout behaviour matched the walk-forward estimate on unseen markets.");

  const window: DateWindow = {
    from: ordered[0]!.window.from,
    to: ordered[ordered.length - 1]!.window.to,
  };
  const retentionTxt = retention == null ? "" : ` (${Math.round(retention * 100)}% of walk-forward Sharpe)`;
  const sentence =
    verdict === "confirmed"
      ? `Holdout ${window.from} → ${window.to} confirmed the walk-forward result: ${totalReturnPct.toFixed(1)}% over ${ordered.length} unseen segments, Sharpe ${sharpe.toFixed(2)}${retentionTxt}.`
      : verdict === "weakened"
        ? `Holdout ${window.from} → ${window.to} was weaker than walk-forward: Sharpe ${sharpe.toFixed(2)}${retentionTxt}, ${Math.round(segmentHitRate * 100)}% of segments profitable.`
        : `Holdout ${window.from} → ${window.to} broke the walk-forward result: Sharpe ${sharpe.toFixed(2)}, worst drawdown ${maxDrawdownPct.toFixed(1)}%. Do not deploy on this fit.`;

  return {
    segments: ordered.length,
    window,
    totalReturnPct: round(totalReturnPct),
    cagrPct: round(cagrPct),
    maxDrawdownPct: round(maxDrawdownPct),
    sharpe: round(sharpe),
    segmentHitRate: round(segmentHitRate, 3),
    sharpeDispersion: round(sharpeDispersion),
    sharpeDecay: round(sharpeDecay),
    cagrDecay: round(cagrDecay),
    retention: retention == null ? null : round(retention, 3),
    benchmarkReturnPct: benchmarkReturnPct == null ? null : round(benchmarkReturnPct),
    excessReturnPct:
      benchmarkReturnPct == null ? null : round(totalReturnPct - benchmarkReturnPct),
    verdict,
    reasons,
    sentence,
  };
}

export type SummaryWithHoldout = WalkForwardSummary & { holdout: HoldoutAssessment };

/**
 * Attach a holdout assessment and let it veto the walk-forward verdict: a
 * broken holdout downgrades any "go" to "no-go", a weakened one to "caution".
 */
export function withHoldout(
  summary: WalkForwardSummary,
  holdout: HoldoutAssessment,
): SummaryWithHoldout {
  const reasons = [...summary.reasons];
  let verdict = summary.verdict;

  if (holdout.verdict === "broken") {
    verdict = "no-go";
    reasons.unshift(holdout.sentence);
  } else if (holdout.verdict === "weakened") {
    if (verdict === "go") verdict = "caution";
    reasons.unshift(holdout.sentence);
  } else if (holdout.verdict === "confirmed") {
    reasons.push(holdout.sentence);
  } else {
    reasons.push(`Holdout not conclusive: ${holdout.reasons[0]}`);
  }

  return { ...summary, verdict, reasons, holdout };
}
