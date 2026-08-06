/**
 * Automatic tuning of the sideways / bear regime thresholds.
 *
 * `DEFAULT_REGIME_THRESHOLDS` were hand-picked: -10%/yr for bear, 15%
 * drawdown, a ±6% chop band, an 8% range floor. Hand-picked numbers are fine
 * as a starting point but they are not evidence, and the labels they produce
 * drive real behaviour — regime-segmented walk-forward verdicts, the λ used by
 * the fee objective, and the de-risking playbook.
 *
 * This module turns the thresholds into a search problem scored against the
 * backtest tape itself. The scoring question is deliberately simple and
 * falsifiable:
 *
 *   *A label is good if it tells you something about what happens next.*
 *
 * Concretely, for a forward horizon of `horizonBars`:
 *   - bear bars should be followed by materially negative forward returns,
 *   - bull bars by materially positive ones,
 *   - sideways bars by returns near zero (low absolute drift),
 * and the labelling must stay usable: every regime needs a minimum share of
 * bars (a threshold set that calls everything sideways "predicts" nothing),
 * and it must not flicker bar to bar.
 *
 * Two searches are provided:
 *   - `gridSearchRegimeThresholds` — exhaustive over a (small) space,
 *   - `searchRegimeThresholds` — coordinate descent, which handles the full
 *     seven-axis space in a few hundred evaluations instead of tens of
 *     thousands, and is what callers should use by default.
 *
 * Both are deterministic and pure: same tape in, same thresholds out. To guard
 * against fitting the labels to one tape, `tuneRegimeThresholds` splits the
 * history, tunes on the front portion and reports the held-out score, and
 * refuses to recommend a change that does not also improve out of sample.
 */

import {
  classifyRegimeBars,
  regimeCoverage,
  DEFAULT_REGIME_THRESHOLDS,
  REGIMES,
  type IndexPoint,
  type RegimeBar,
  type RegimeLabel,
  type RegimeThresholds,
} from "@/lib/regime-walk-forward";

/** Threshold keys the search is allowed to move. */
export const TUNABLE_KEYS = [
  "lookback",
  "bullAnnualPct",
  "bearAnnualPct",
  "bearDrawdownPct",
  "sidewaysBandPct",
  "sidewaysRangePct",
  "minTrendR2",
  "sidewaysMaxDrawdownPct",
] as const;

export type TunableKey = (typeof TUNABLE_KEYS)[number];

/** Candidate values per axis. Missing axes stay pinned at the base value. */
export type RegimeSearchSpace = Partial<Record<TunableKey, readonly number[]>>;

/**
 * Default space, centred on the shipped defaults. Deliberately coarse: the
 * labels are a coarse instrument, and a finer grid mostly buys overfitting.
 */
export const DEFAULT_SEARCH_SPACE: RegimeSearchSpace = {
  lookback: [42, 63, 84, 126],
  bullAnnualPct: [6, 8, 10, 14, 18],
  bearAnnualPct: [-18, -14, -10, -6, -4],
  bearDrawdownPct: [8, 10, 12, 15, 20, 25],
  sidewaysBandPct: [2, 4, 6, 8, 12],
  sidewaysRangePct: [4, 6, 8, 12, 16],
  minTrendR2: [0.15, 0.25, 0.35, 0.5, 0.65],
  sidewaysMaxDrawdownPct: [4, 6, 8, 12, 16],
};

/** Sideways/bear-only space, for callers that want bull left untouched. */
export const SIDEWAYS_BEAR_SPACE: RegimeSearchSpace = {
  bearAnnualPct: DEFAULT_SEARCH_SPACE.bearAnnualPct,
  bearDrawdownPct: DEFAULT_SEARCH_SPACE.bearDrawdownPct,
  sidewaysBandPct: DEFAULT_SEARCH_SPACE.sidewaysBandPct,
  sidewaysRangePct: DEFAULT_SEARCH_SPACE.sidewaysRangePct,
  sidewaysMaxDrawdownPct: DEFAULT_SEARCH_SPACE.sidewaysMaxDrawdownPct,
  minTrendR2: DEFAULT_SEARCH_SPACE.minTrendR2,
};

export type RegimeScoreOptions = {
  /** Forward window the label is judged against, in bars (default 21). */
  horizonBars: number;
  /** Minimum share of bars each regime must carry, 0..1 (default 0.08). */
  minRegimeShare: number;
  /** Penalty weight applied to missing coverage (default 40). */
  coveragePenalty: number;
  /** Penalty weight applied to the bar-to-bar label flip rate (default 25). */
  flipPenalty: number;
  /**
   * Forward move, in %, treated as "flat" for the sideways test. Sideways
   * bars score on how much of their forward move stays inside this (default 3).
   */
  flatBandPct: number;
  /** Weight on the bear/sideways terms relative to bull (default 1.5). */
  bearWeight: number;
};

export const DEFAULT_SCORE_OPTIONS: RegimeScoreOptions = {
  horizonBars: 21,
  minRegimeShare: 0.08,
  coveragePenalty: 40,
  flipPenalty: 25,
  flatBandPct: 3,
  bearWeight: 1.5,
};

/** Per-regime forward-return statistics behind a score. */
export type RegimeForwardStats = {
  bars: number;
  share: number;
  /** Mean forward return over the horizon, in %. */
  meanForwardPct: number;
  /** Share of bars whose forward move matched the label's expectation. */
  hitRate: number;
};

export type RegimeThresholdScore = {
  score: number;
  /** Predictive component before penalties. */
  separation: number;
  coverageShortfall: number;
  flipRate: number;
  stats: Record<RegimeLabel, RegimeForwardStats>;
  /** Bars that had a full forward horizon available. */
  scoredBars: number;
};

/** Forward return over `horizon` bars from each index point, in %. */
export function forwardReturnsPct(index: readonly IndexPoint[], horizon: number): Array<number | null> {
  const h = Math.max(1, Math.floor(horizon));
  return index.map((p, i) => {
    const future = index[i + h];
    if (!future || !(p.value > 0) || !(future.value > 0)) return null;
    return (future.value / p.value - 1) * 100;
  });
}

/** Share of adjacent bar pairs whose label changed — the flicker read. */
export function labelFlipRate(bars: readonly RegimeBar[]): number {
  if (bars.length < 2) return 0;
  let flips = 0;
  for (let i = 1; i < bars.length; i++) if (bars[i]!.label !== bars[i - 1]!.label) flips++;
  return flips / (bars.length - 1);
}

const EMPTY_STATS: RegimeForwardStats = { bars: 0, share: 0, meanForwardPct: 0, hitRate: 0 };

/**
 * Score one threshold set against a tape.
 *
 * Separation is the confidence-free, scale-free part: bull bars earn their
 * mean forward return, bear bars earn the negative of theirs (so a bear label
 * ahead of a -12% month scores +12), and sideways bars earn how tightly their
 * forward moves cling to the flat band. Weighted so the two regimes we are
 * actually tuning — bear and sideways — dominate.
 *
 * Penalties then push back on the two degenerate solutions: labelling almost
 * nothing bear (great precision, useless coverage) and labelling every other
 * bar differently (great in-sample fit, unusable in production).
 */
export function scoreRegimeThresholds(
  index: readonly IndexPoint[],
  thresholds: RegimeThresholds,
  options: Partial<RegimeScoreOptions> = {},
): RegimeThresholdScore {
  const o = { ...DEFAULT_SCORE_OPTIONS, ...options };
  const empty: RegimeThresholdScore = {
    score: Number.NEGATIVE_INFINITY,
    separation: 0,
    coverageShortfall: 1,
    flipRate: 0,
    stats: { bull: EMPTY_STATS, bear: EMPTY_STATS, sideways: EMPTY_STATS },
    scoredBars: 0,
  };
  if (index.length < 3) return empty;

  let bars: RegimeBar[];
  try {
    bars = classifyRegimeBars(index, thresholds);
  } catch {
    // Invalid combinations (e.g. bear >= bull) are simply infeasible.
    return empty;
  }

  const fwd = forwardReturnsPct(index, o.horizonBars);
  const buckets: Record<RegimeLabel, number[]> = { bull: [], bear: [], sideways: [] };
  for (let i = 0; i < bars.length; i++) {
    const r = fwd[i];
    if (r === null || r === undefined) continue;
    buckets[bars[i]!.label].push(r);
  }
  const scoredBars = REGIMES.reduce((n, r) => n + buckets[r].length, 0);
  if (scoredBars === 0) return empty;

  const coverage = regimeCoverage(bars);
  const stats = {} as Record<RegimeLabel, RegimeForwardStats>;
  for (const r of REGIMES) {
    const xs = buckets[r];
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const hits = xs.filter((v) =>
      r === "bull" ? v > 0 : r === "bear" ? v < 0 : Math.abs(v) <= o.flatBandPct,
    ).length;
    stats[r] = {
      bars: coverage[r].bars,
      share: coverage[r].share,
      meanForwardPct: mean,
      hitRate: xs.length ? hits / xs.length : 0,
    };
  }

  // Sideways earns points for staying flat: full credit at zero drift,
  // nothing once the mean |move| reaches twice the flat band.
  const sidewaysAbs = buckets.sideways.length
    ? buckets.sideways.reduce((a, b) => a + Math.abs(b), 0) / buckets.sideways.length
    : 0;
  const flatness = Math.max(0, 1 - sidewaysAbs / Math.max(1e-9, 2 * o.flatBandPct));

  const w = (r: RegimeLabel) => (r === "bull" ? 1 : o.bearWeight) * stats[r].share;
  const separation =
    w("bull") * stats.bull.meanForwardPct +
    w("bear") * -stats.bear.meanForwardPct +
    w("sideways") * flatness * o.flatBandPct;

  let coverageShortfall = 0;
  for (const r of REGIMES) coverageShortfall += Math.max(0, o.minRegimeShare - stats[r].share);
  const flipRate = labelFlipRate(bars);

  return {
    score: separation - o.coveragePenalty * coverageShortfall - o.flipPenalty * flipRate,
    separation,
    coverageShortfall,
    flipRate,
    stats,
    scoredBars,
  };
}

export type RegimeThresholdTrial = {
  thresholds: RegimeThresholds;
  score: RegimeThresholdScore;
  /** Only the axes that differ from the base thresholds. */
  changed: Partial<Record<TunableKey, number>>;
};

const diffOf = (base: RegimeThresholds, cand: RegimeThresholds): Partial<Record<TunableKey, number>> => {
  const out: Partial<Record<TunableKey, number>> = {};
  for (const k of TUNABLE_KEYS) if (cand[k] !== base[k]) out[k] = cand[k];
  return out;
};

/** Deterministic tie-break so equal scores never depend on iteration order. */
function better(a: RegimeThresholdTrial, b: RegimeThresholdTrial): RegimeThresholdTrial {
  if (b.score.score > a.score.score + 1e-12) return b;
  if (a.score.score > b.score.score + 1e-12) return a;
  // Prefer the simpler change, then the lower flip rate.
  const ka = Object.keys(a.changed).length;
  const kb = Object.keys(b.changed).length;
  if (kb < ka) return b;
  if (ka < kb) return a;
  return b.score.flipRate < a.score.flipRate - 1e-12 ? b : a;
}

export type SearchOptions = {
  space?: RegimeSearchSpace;
  base?: RegimeThresholds;
  score?: Partial<RegimeScoreOptions>;
  /** Coordinate-descent sweeps over every axis (default 3). */
  passes?: number;
  /** Cap on evaluations; the search stops early and reports what it has. */
  maxEvaluations?: number;
};

export type RegimeSearchResult = {
  best: RegimeThresholdTrial;
  baseline: RegimeThresholdTrial;
  /** Every distinct candidate evaluated, best first. */
  trials: RegimeThresholdTrial[];
  evaluations: number;
  /** best.score − baseline.score. Negative is impossible: base is a candidate. */
  improvement: number;
};

function evaluate(
  index: readonly IndexPoint[],
  base: RegimeThresholds,
  thresholds: RegimeThresholds,
  score: Partial<RegimeScoreOptions>,
): RegimeThresholdTrial {
  return {
    thresholds,
    score: scoreRegimeThresholds(index, thresholds, score),
    changed: diffOf(base, thresholds),
  };
}

const keyOf = (t: RegimeThresholds) => TUNABLE_KEYS.map((k) => `${k}=${t[k]}`).join("|");

/**
 * Coordinate descent over the search space: sweep each axis in turn holding
 * the others at the incumbent best, keep any improvement, repeat. Converges in
 * `passes` sweeps or as soon as a full sweep changes nothing.
 */
export function searchRegimeThresholds(
  index: readonly IndexPoint[],
  options: SearchOptions = {},
): RegimeSearchResult {
  const base = options.base ?? DEFAULT_REGIME_THRESHOLDS;
  const space = options.space ?? DEFAULT_SEARCH_SPACE;
  const passes = Math.max(1, Math.floor(options.passes ?? 3));
  const maxEvaluations = Math.max(1, Math.floor(options.maxEvaluations ?? 2_000));

  const seen = new Map<string, RegimeThresholdTrial>();
  const run = (t: RegimeThresholds): RegimeThresholdTrial => {
    const k = keyOf(t);
    const hit = seen.get(k);
    if (hit) return hit;
    const trial = evaluate(index, base, t, options.score ?? {});
    seen.set(k, trial);
    return trial;
  };

  const baseline = run(base);
  let incumbent = baseline;

  outer: for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const key of TUNABLE_KEYS) {
      const values = space[key];
      if (!values || values.length === 0) continue;
      for (const value of values) {
        if (incumbent.thresholds[key] === value) continue;
        if (seen.size >= maxEvaluations) break outer;
        const candidate = run({ ...incumbent.thresholds, [key]: value });
        const winner = better(incumbent, candidate);
        if (winner !== incumbent) {
          incumbent = winner;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  const trials = [...seen.values()].sort((a, b) => b.score.score - a.score.score);
  return {
    best: incumbent,
    baseline,
    trials,
    evaluations: seen.size,
    improvement: incumbent.score.score - baseline.score.score,
  };
}

/**
 * Exhaustive grid over the space. Use only for small spaces (it multiplies
 * out); `maxEvaluations` is a hard stop rather than a suggestion.
 */
export function gridSearchRegimeThresholds(
  index: readonly IndexPoint[],
  options: SearchOptions = {},
): RegimeSearchResult {
  const base = options.base ?? DEFAULT_REGIME_THRESHOLDS;
  const space = options.space ?? SIDEWAYS_BEAR_SPACE;
  const maxEvaluations = Math.max(1, Math.floor(options.maxEvaluations ?? 5_000));
  const axes = TUNABLE_KEYS.filter((k) => (space[k]?.length ?? 0) > 0);

  let combos: RegimeThresholds[] = [base];
  for (const key of axes) {
    const next: RegimeThresholds[] = [];
    for (const combo of combos) for (const v of space[key]!) next.push({ ...combo, [key]: v });
    combos = next;
    if (combos.length > maxEvaluations) {
      combos = combos.slice(0, maxEvaluations);
      break;
    }
  }
  if (!combos.some((c) => keyOf(c) === keyOf(base))) combos.unshift(base);

  const seen = new Map<string, RegimeThresholdTrial>();
  for (const c of combos) {
    const k = keyOf(c);
    if (seen.has(k)) continue;
    if (seen.size >= maxEvaluations) break;
    seen.set(k, evaluate(index, base, c, options.score ?? {}));
  }

  const baseline = seen.get(keyOf(base)) ?? evaluate(index, base, base, options.score ?? {});
  let incumbent = baseline;
  for (const t of seen.values()) incumbent = better(incumbent, t);
  const trials = [...seen.values()].sort((a, b) => b.score.score - a.score.score);
  return {
    best: incumbent,
    baseline,
    trials,
    evaluations: seen.size,
    improvement: incumbent.score.score - baseline.score.score,
  };
}

export type TuneOptions = SearchOptions & {
  /** Fraction of the tape tuned on; the rest is held out (default 0.7). */
  trainFraction?: number;
  /** Minimum held-out improvement required to adopt (default 0). */
  minHoldoutImprovement?: number;
  /** Use the exhaustive grid instead of coordinate descent (default false). */
  exhaustive?: boolean;
};

export type RegimeTuningResult = {
  /** Thresholds the caller should actually use — base unless adopted. */
  recommended: RegimeThresholds;
  /** True when the tuned set beat the base out of sample too. */
  adopted: boolean;
  /** Why it was or was not adopted. */
  reason: string;
  train: RegimeSearchResult;
  /** Held-out score of the tuned set and of the base, same slice. */
  holdout: { tuned: RegimeThresholdScore; base: RegimeThresholdScore; improvement: number };
  changed: Partial<Record<TunableKey, number>>;
};

/**
 * Tune on the front of the tape, verify on the back, and only recommend a
 * change that survives both. This is the entry point callers should use: a
 * threshold set that wins in-sample and loses out of sample is overfitting,
 * and silently shipping it would make the regime labels worse than the
 * hand-picked defaults they replaced.
 */
export function tuneRegimeThresholds(
  index: readonly IndexPoint[],
  options: TuneOptions = {},
): RegimeTuningResult {
  const base = options.base ?? DEFAULT_REGIME_THRESHOLDS;
  const frac = Math.min(0.95, Math.max(0.3, options.trainFraction ?? 0.7));
  const cut = Math.floor(index.length * frac);
  const trainSlice = index.slice(0, cut);
  const testSlice = index.slice(cut);

  const search = options.exhaustive ? gridSearchRegimeThresholds : searchRegimeThresholds;
  const train = search(trainSlice.length >= 3 ? trainSlice : index, options);

  const tunedHoldout = scoreRegimeThresholds(testSlice, train.best.thresholds, options.score ?? {});
  const baseHoldout = scoreRegimeThresholds(testSlice, base, options.score ?? {});
  const finite = Number.isFinite(tunedHoldout.score) && Number.isFinite(baseHoldout.score);
  const improvement = finite ? tunedHoldout.score - baseHoldout.score : 0;
  const floor = options.minHoldoutImprovement ?? 0;

  const unchanged = Object.keys(train.best.changed).length === 0;
  const adopted = !unchanged && finite && improvement > floor && train.improvement > 0;
  const reason = unchanged
    ? "search found no threshold set better than the defaults in-sample"
    : !finite
      ? "held-out slice too short to validate — keeping defaults"
      : adopted
        ? `tuned set improved held-out score by ${improvement.toFixed(2)}`
        : `tuned set failed out of sample (held-out delta ${improvement.toFixed(2)} <= ${floor})`;

  return {
    recommended: adopted ? train.best.thresholds : base,
    adopted,
    reason,
    train,
    holdout: { tuned: tunedHoldout, base: baseHoldout, improvement },
    changed: adopted ? train.best.changed : {},
  };
}

/** Human-readable summary for reports and CLI output. */
export function formatRegimeTuning(result: RegimeTuningResult): string {
  const lines: string[] = [];
  lines.push(
    `regime tuning: ${result.adopted ? "ADOPTED" : "kept defaults"} — ${result.reason}`,
  );
  lines.push(
    `  in-sample ${result.train.baseline.score.score.toFixed(2)} → ` +
      `${result.train.best.score.score.toFixed(2)} over ${result.train.evaluations} evaluations`,
  );
  lines.push(
    `  held-out  ${result.holdout.base.score.toFixed(2)} → ${result.holdout.tuned.score.toFixed(2)}`,
  );
  const changed = Object.entries(result.train.best.changed);
  lines.push(
    changed.length
      ? `  changed: ${changed.map(([k, v]) => `${k} ${DEFAULT_REGIME_THRESHOLDS[k as TunableKey]} → ${v}`).join(", ")}`
      : "  changed: nothing",
  );
  for (const r of REGIMES) {
    const s = result.train.best.score.stats[r];
    lines.push(
      `  ${r.padEnd(8)} share ${(s.share * 100).toFixed(1)}%  fwd ${s.meanForwardPct.toFixed(2)}%  hit ${(s.hitRate * 100).toFixed(0)}%`,
    );
  }
  return lines.join("\n");
}
