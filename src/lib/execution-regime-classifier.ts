// Out-of-sample regime classifier: when does the coupling assumption matter?
//
// Every tail number in this folder is an average over a tape that contains two
// very different worlds. Most bars are calm, and in a calm tape almost any
// correlation assumption prices execution about the same — the shocks are small
// enough that how they co-move barely registers. The interesting question is
// whether the calibrated structures earn their keep in the minority of bars
// where the tape is actually stressed, and you cannot answer that by looking at
// a blended number.
//
// So: label the bars, then re-run the backtest separately on each label.
//
// The label has to be out of sample or the exercise is circular. The simulator
// already has an internal notion of stress (the Markov regime inside the shock
// sampler), but that is a *modelled* state, not a measurement of the tape, and
// the calibration's own stress windows are fitted on the same bars they label.
// This classifier instead:
//
//   1. fits its thresholds on TRAIN bars only — the stress-entry threshold is a
//      quantile of the train-window realised-vol z-scores, so "stressed" means
//      "loud relative to what we had already seen", never relative to the
//      future;
//   2. labels the untouched TEST bars with hysteresis (enter high, exit lower)
//      and a minimum run length, because a regime that flickers bar to bar is
//      not a regime and would chop the test window into unusable slivers;
//   3. reports how well the labels actually separate — if stressed bars are not
//      materially louder than calm ones on the test window, the split is noise
//      and the per-regime tables below it mean nothing.
//
// Nothing here simulates or knows about correlation structures. The caller
// hands back measured per-regime metrics and this module tabulates them.

// ------------------------------------------------------------- fitting

export type RegimeClassifierOptions = {
  /** Train-window quantile of vol-z used as the stress-entry threshold. */
  stressQuantile?: number;
  /** Exit threshold sits this far below entry, in z units (hysteresis band). */
  hysteresis?: number;
  /** Runs shorter than this are absorbed into the surrounding regime. */
  minRunBars?: number;
};

export const DEFAULT_REGIME_OPTIONS: Required<RegimeClassifierOptions> = {
  stressQuantile: 0.85,
  hysteresis: 0.5,
  minRunBars: 3,
};

export type RegimeClassifier = {
  /** Bar enters stress when its vol-z is at or above this. */
  enterZ: number;
  /** Stress ends when vol-z drops below this (always ≤ enterZ). */
  exitZ: number;
  stressQuantile: number;
  hysteresis: number;
  minRunBars: number;
  trainBars: number;
  /** Share of TRAIN bars the fitted rule would have called stressed, %. */
  trainStressShare: number;
};

const finite = (xs: readonly number[]) => xs.filter((v) => Number.isFinite(v));

/** Linear-interpolated quantile of a sample; NaN for an empty sample. */
export function quantileOf(xs: readonly number[], q: number): number {
  const s = finite(xs).slice().sort((a, b) => a - b);
  if (!s.length) return Number.NaN;
  const pos = Math.min(Math.max(q, 0), 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo]! : s[lo]! + (pos - lo) * (s[hi]! - s[lo]!);
}

/**
 * Fits entry/exit thresholds on train-window vol-z scores only.
 *
 * A degenerate train window (all-equal z, or too few bars) still returns a
 * usable classifier: the thresholds collapse onto the sample's own top value,
 * which labels essentially nothing as stressed rather than labelling everything
 * as stressed. Over-labelling would silently turn the "stress" table into the
 * blended table it is supposed to be contrasted with.
 */
export function fitRegimeClassifier(
  trainVolZ: readonly number[],
  opts: RegimeClassifierOptions = {},
): RegimeClassifier {
  const o = { ...DEFAULT_REGIME_OPTIONS, ...opts };
  const sample = finite(trainVolZ);
  const enterZ = sample.length ? quantileOf(sample, o.stressQuantile) : Number.POSITIVE_INFINITY;
  const exitZ = enterZ - Math.max(0, o.hysteresis);
  const clf: RegimeClassifier = {
    enterZ,
    exitZ,
    stressQuantile: o.stressQuantile,
    hysteresis: Math.max(0, o.hysteresis),
    minRunBars: Math.max(1, Math.floor(o.minRunBars)),
    trainBars: sample.length,
    trainStressShare: 0,
  };
  const labels = classifyRegimes(clf, trainVolZ);
  clf.trainStressShare = labels.length
    ? (labels.filter(Boolean).length / labels.length) * 100
    : 0;
  return clf;
}

// ------------------------------------------------------------- labelling

/**
 * Labels bars stressed/calm with hysteresis, then removes runs shorter than
 * `minRunBars` by merging them into the run before them (the first run keeps
 * its label, since there is nothing before it to merge into).
 */
export function classifyRegimes(
  clf: RegimeClassifier,
  volZ: readonly number[],
): boolean[] {
  const raw: boolean[] = [];
  let stressed = false;
  for (const z of volZ) {
    const v = Number.isFinite(z) ? z : -Infinity;
    if (!stressed && v >= clf.enterZ) stressed = true;
    else if (stressed && v < clf.exitZ) stressed = false;
    raw.push(stressed);
  }
  return smoothRuns(raw, clf.minRunBars);
}

function smoothRuns(labels: readonly boolean[], minRunBars: number): boolean[] {
  if (minRunBars <= 1 || labels.length === 0) return [...labels];
  const out = [...labels];
  let runStart = 0;
  for (let i = 1; i <= out.length; i++) {
    if (i < out.length && out[i] === out[runStart]) continue;
    const len = i - runStart;
    if (len < minRunBars && runStart > 0) {
      const prev = out[runStart - 1]!;
      for (let k = runStart; k < i; k++) out[k] = prev;
    }
    runStart = i;
  }
  return out;
}

export type RegimeName = "calm" | "stress";

export type RegimeSegment = {
  regime: RegimeName;
  /** Absolute bar indices into the tape, inclusive. */
  start: number;
  end: number;
  bars: number;
};

/**
 * Contiguous same-label windows, as absolute bar indices.
 *
 * `minBars` drops segments too short to backtest — a two-bar window produces a
 * return that is all entry cost and no signal.
 */
export function regimeSegments(
  labels: readonly boolean[],
  offset = 0,
  minBars = 1,
): RegimeSegment[] {
  const out: RegimeSegment[] = [];
  let start = 0;
  for (let i = 1; i <= labels.length; i++) {
    if (i < labels.length && labels[i] === labels[start]) continue;
    const bars = i - start;
    if (bars >= minBars) {
      out.push({
        regime: labels[start] ? "stress" : "calm",
        start: offset + start,
        end: offset + i - 1,
        bars,
      });
    }
    start = i;
  }
  return out;
}

// ------------------------------------------------------------- validation

export type RegimeSeparation = {
  bars: number;
  calmBars: number;
  stressBars: number;
  stressShare: number;
  meanZCalm: number;
  meanZStress: number;
  /** Standardised gap between the two groups' vol-z (Cohen's d). */
  separation: number;
  transitions: number;
  meanStressRunBars: number;
};

const mean = (xs: readonly number[]) =>
  finite(xs).length ? finite(xs).reduce((a, b) => a + b, 0) / finite(xs).length : Number.NaN;

/**
 * Does the label actually pick out a different tape?
 *
 * `separation` is a pooled-SD standardised mean difference. Below ~0.5 the
 * classifier is splitting noise and the per-regime tables should be read as
 * "no measurable regime here", not as evidence about coupling.
 */
export function regimeSeparation(
  labels: readonly boolean[],
  volZ: readonly number[],
): RegimeSeparation {
  const calm: number[] = [];
  const stress: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    const z = volZ[i];
    if (!Number.isFinite(z)) continue;
    (labels[i] ? stress : calm).push(z as number);
  }
  const mc = mean(calm);
  const ms = mean(stress);
  const pooledVar = (xs: number[], m: number) =>
    xs.length > 1 ? xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) : 0;
  const n = calm.length + stress.length;
  const sd = Math.sqrt(
    n > 2
      ? ((calm.length - 1) * pooledVar(calm, mc) + (stress.length - 1) * pooledVar(stress, ms)) /
          Math.max(1, n - 2)
      : 0,
  );

  let transitions = 0;
  for (let i = 1; i < labels.length; i++) if (labels[i] !== labels[i - 1]) transitions++;
  const stressRuns = regimeSegments(labels).filter((s) => s.regime === "stress");

  return {
    bars: labels.length,
    calmBars: calm.length,
    stressBars: stress.length,
    stressShare: labels.length ? (labels.filter(Boolean).length / labels.length) * 100 : 0,
    meanZCalm: mc,
    meanZStress: ms,
    separation: sd > 0 ? (ms - mc) / sd : 0,
    transitions,
    meanStressRunBars: stressRuns.length ? mean(stressRuns.map((s) => s.bars)) : 0,
  };
}

// ------------------------------------------------------------- reporting

/** Metrics measured on one arm's paths restricted to one regime's segments. */
export type RegimeArmMetrics = {
  arm: string;
  regime: RegimeName;
  /** Total labelled bars behind the row, summed across folds. */
  bars: number;
  segments: number;
  /** Bar-normalised return so calm and stress rows are comparable. */
  returnPer100Bars: number;
  cvar5Per100Bars: number;
  worstDrawdownPct: number;
  breachProb: number;
  costPer100Bars: number;
};

export type RegimeArmEdge = {
  arm: string;
  regime: RegimeName;
  /** arm − baseline on each metric; the sign convention is the metric's own. */
  returnEdge: number;
  cvar5Edge: number;
  worstDrawdownEdge: number;
  breachEdge: number;
  costEdge: number;
};

export type RegimeBacktestReport = {
  separation: RegimeSeparation;
  classifier: RegimeClassifier;
  rows: RegimeArmMetrics[];
  baseline: string;
  edges: RegimeArmEdge[];
  /**
   * |CVaR edge in stress| − |CVaR edge in calm| for each arm: positive means
   * the coupling assumption only bites when the tape is loud, which is the
   * whole hypothesis under test.
   */
  stressOnlyEdge: { arm: string; value: number }[];
};

export function regimeBacktestReport(
  classifier: RegimeClassifier,
  separation: RegimeSeparation,
  rows: readonly RegimeArmMetrics[],
  baseline: string,
): RegimeBacktestReport {
  const find = (arm: string, regime: RegimeName) =>
    rows.find((r) => r.arm === arm && r.regime === regime);
  const arms = [...new Set(rows.map((r) => r.arm))].filter((a) => a !== baseline);

  const edges: RegimeArmEdge[] = [];
  for (const arm of arms) {
    for (const regime of ["calm", "stress"] as const) {
      const a = find(arm, regime);
      const b = find(baseline, regime);
      if (!a || !b) continue;
      edges.push({
        arm,
        regime,
        returnEdge: a.returnPer100Bars - b.returnPer100Bars,
        cvar5Edge: a.cvar5Per100Bars - b.cvar5Per100Bars,
        worstDrawdownEdge: a.worstDrawdownPct - b.worstDrawdownPct,
        breachEdge: a.breachProb - b.breachProb,
        costEdge: a.costPer100Bars - b.costPer100Bars,
      });
    }
  }

  const stressOnlyEdge = arms.map((arm) => {
    const calm = edges.find((e) => e.arm === arm && e.regime === "calm");
    const stress = edges.find((e) => e.arm === arm && e.regime === "stress");
    return {
      arm,
      value: Math.abs(stress?.cvar5Edge ?? 0) - Math.abs(calm?.cvar5Edge ?? 0),
    };
  });

  return { classifier, separation, rows: [...rows], baseline, edges, stressOnlyEdge };
}

const num = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const signed = (v: number, d = 2) => (v > 0 ? `+${num(v, d)}` : num(v, d));

export function formatRegimeBacktest(report: RegimeBacktestReport): string {
  const { classifier: c, separation: s } = report;
  const out: string[] = [];

  out.push(
    `classifier: enter z ≥ ${num(c.enterZ)} / exit z < ${num(c.exitZ)} ` +
      `(train q${(c.stressQuantile * 100).toFixed(0)}, min run ${c.minRunBars} bars, ` +
      `${num(c.trainStressShare, 1)}% of train bars stressed)`,
  );
  out.push(
    `test labels: ${s.stressBars}/${s.bars} bars stressed (${num(s.stressShare, 1)}%), ` +
      `${s.transitions} transitions, mean stress run ${num(s.meanStressRunBars, 1)} bars`,
  );
  out.push(
    `separation: mean vol-z ${num(s.meanZCalm)} calm vs ${num(s.meanZStress)} stress ` +
      `(d = ${num(s.separation)}${s.separation < 0.5 ? " — too weak to read the tables below" : ""})`,
  );
  out.push("");

  const head =
    "arm".padEnd(18) +
    ["regime", "bars", "segs", "ret/100b", "CVaR5", "worstDD", "P(brch)", "cost/100b"]
      .map((h) => h.padStart(10))
      .join("");
  out.push(head);
  for (const r of report.rows) {
    out.push(
      r.arm.padEnd(18) +
        [
          r.regime,
          String(r.bars),
          String(r.segments),
          num(r.returnPer100Bars),
          num(r.cvar5Per100Bars),
          num(r.worstDrawdownPct),
          `${num(r.breachProb * 100, 1)}%`,
          num(r.costPer100Bars, 0),
        ]
          .map((v) => v.padStart(10))
          .join(""),
    );
  }

  out.push("");
  out.push(`edge vs ${report.baseline} (arm − baseline)`);
  out.push(
    "arm".padEnd(18) +
      ["regime", "Δret", "ΔCVaR5", "ΔworstDD", "Δbreach", "Δcost"].map((h) => h.padStart(11)).join(""),
  );
  for (const e of report.edges) {
    out.push(
      e.arm.padEnd(18) +
        [
          e.regime,
          signed(e.returnEdge),
          signed(e.cvar5Edge),
          signed(e.worstDrawdownEdge),
          `${signed(e.breachEdge * 100, 1)}pp`,
          signed(e.costEdge, 0),
        ]
          .map((v) => v.padStart(11))
          .join(""),
    );
  }

  out.push("");
  for (const { arm, value } of report.stressOnlyEdge) {
    out.push(
      `  ${arm}: |ΔCVaR5| is ${num(Math.abs(value))} ${value >= 0 ? "larger" : "smaller"} in stress than in calm` +
        (value > 0 ? " — the coupling assumption matters when the tape is loud" : ""),
    );
  }

  return out.join("\n");
}
