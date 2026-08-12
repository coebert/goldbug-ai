// Rolling out-of-sample (walk-forward) evaluation of the insider nudge.
//
// The single-pass replay reports one in-sample number, which flatters any knob
// you tuned after looking at the tape. This module walks the history forward:
//   * train on the first N months — pick the nudge strength that did best there;
//   * evaluate the NEXT M months with that strength, untouched;
//   * roll the window forward by M months and repeat.
//
// Only the evaluation windows are stitched into the out-of-sample curve, so the
// reported return, drawdown and VaR are what the strategy would have earned
// with decisions made only from prior data. Both arms use the same risk-dial
// sizing as the live AI (see `replay-risk-sizing`).
//
// Pure: no network, no database. Prices and events are injected.

import {
  runNudgeReplay,
  DEFAULT_REPLAY_PARAMS,
  type Candlelike,
  type ReplayEvent,
  type ReplayParams,
  type NudgeReplayResult,
} from "./insider-nudge-replay";
import { tailRisk } from "./replay-risk-sizing";

export type WalkForwardOptions = {
  /** Months of history each fold trains on. */
  trainMonths: number;
  /** Months of untouched history each fold is scored on. */
  testMonths: number;
  /** Nudge strengths the training window is allowed to choose between. */
  scaleGrid: number[];
  /** Metric the training window optimises. */
  objective: "return" | "sharpe" | "calmar";
  /** Warm-up bars prepended to every window so the 50-day average exists. */
  warmupDays: number;
};

export const DEFAULT_WALK_FORWARD: WalkForwardOptions = {
  trainMonths: 9,
  testMonths: 3,
  scaleGrid: [0, 0.5, 1, 2],
  objective: "return",
  warmupDays: 90,
};

export type FoldResult = {
  index: number;
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  /** Nudge strength the training window selected. */
  chosenScale: number;
  /** Objective value the chosen scale scored in training. */
  trainScore: number;
  /** Training-window edge of the chosen scale over the no-nudge arm, pp. */
  trainDeltaPct: number;
  /** Out-of-sample results for the evaluation window. */
  testBaselinePct: number;
  testNudgedPct: number;
  testDeltaPct: number;
  testDays: number;
};

export type OosArm = {
  label: string;
  /** Compounded out-of-sample equity curve across evaluation windows only. */
  curve: Array<{ date: string; equity: number }>;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  var95Pct: number;
  cvar95Pct: number;
};

export type WalkForwardResult = {
  from: string;
  to: string;
  symbols: string[];
  options: WalkForwardOptions;
  riskLevel: number;
  folds: FoldResult[];
  baseline: OosArm;
  nudged: OosArm;
  delta: {
    returnPct: number;
    maxDrawdownPct: number;
    sharpe: number;
    var95Pct: number;
  };
  /** Share of folds where the nudge arm beat baseline out of sample. */
  foldWinRate: number;
  /** How often training picked a non-zero nudge. */
  nonZeroScaleFolds: number;
  verdict: "helps" | "neutral" | "hurts" | "insufficient";
  summary: string;
};

export type WalkForwardInput = {
  prices: ReadonlyMap<string, readonly Candlelike[]>;
  events: readonly ReplayEvent[];
  params?: Partial<ReplayParams>;
  options?: Partial<WalkForwardOptions>;
  startingEquity?: number;
};

const DAY = 86_400_000;

export function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const target = new Date(d);
  target.setUTCMonth(target.getUTCMonth() + months);
  return target.toISOString().slice(0, 10);
}

export function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** Slice every symbol's tape to [from, to] inclusive, dropping empty series. */
export function slicePrices(
  prices: ReadonlyMap<string, readonly Candlelike[]>,
  from: string,
  to: string,
): Map<string, Candlelike[]> {
  const out = new Map<string, Candlelike[]>();
  for (const [sym, series] of prices) {
    const cut = series.filter((c) => c.date >= from && c.date <= to);
    if (cut.length > 0) out.set(sym, cut);
  }
  return out;
}

function sliceEvents(events: readonly ReplayEvent[], from: string, to: string): ReplayEvent[] {
  return events.filter((e) => e.date >= from && e.date <= to);
}

/**
 * Fold boundaries over the available tape. Each fold trains on `trainMonths`
 * and is scored on the `testMonths` that follow, then the window rolls forward
 * by one evaluation period (non-overlapping test windows).
 */
export function planFolds(
  first: string,
  last: string,
  o: Pick<WalkForwardOptions, "trainMonths" | "testMonths">,
): Array<{ trainFrom: string; trainTo: string; testFrom: string; testTo: string }> {
  const folds: Array<{ trainFrom: string; trainTo: string; testFrom: string; testTo: string }> = [];
  let trainFrom = first;
  for (let guard = 0; guard < 64; guard++) {
    const trainTo = addMonths(trainFrom, o.trainMonths);
    const testFrom = shiftDays(trainTo, 1);
    const testTo = addMonths(testFrom, o.testMonths);
    if (testFrom > last) break;
    folds.push({ trainFrom, trainTo, testFrom, testTo: testTo > last ? last : testTo });
    if (testTo >= last) break;
    trainFrom = addMonths(trainFrom, o.testMonths);
  }
  return folds;
}

function objectiveOf(r: NudgeReplayResult, which: WalkForwardOptions["objective"]): number {
  const arm = r.nudged;
  if (which === "sharpe") return arm.sharpe;
  if (which === "calmar") {
    const dd = Math.abs(arm.maxDrawdownPct);
    return dd > 0.01 ? arm.totalReturnPct / dd : arm.totalReturnPct;
  }
  return arm.totalReturnPct;
}

function armFrom(
  label: string,
  curve: Array<{ date: string; equity: number }>,
  rets: number[],
  start: number,
): OosArm {
  let peak = -Infinity;
  let worst = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) worst = Math.min(worst, (p.equity - peak) / peak);
  }
  const t = tailRisk(rets);
  const m = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd =
    rets.length > 1
      ? Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1))
      : 0;
  const finalEquity = curve.length ? (curve[curve.length - 1] as { equity: number }).equity : start;
  return {
    label,
    curve,
    totalReturnPct: Number(((finalEquity / start - 1) * 100).toFixed(3)),
    maxDrawdownPct: Number((worst * 100).toFixed(3)),
    sharpe: sd > 0 ? Number(((m / sd) * Math.sqrt(252)).toFixed(2)) : 0,
    var95Pct: t.var95Pct,
    cvar95Pct: t.cvar95Pct,
  };
}

/**
 * Roll train/test windows forward, tuning the nudge strength in-sample and
 * scoring it out-of-sample. Returns the stitched OOS curves for both arms.
 */
export function runNudgeWalkForward(input: WalkForwardInput): WalkForwardResult {
  const options: WalkForwardOptions = {
    ...DEFAULT_WALK_FORWARD,
    ...(input.options ?? {}),
    scaleGrid: (input.options?.scaleGrid?.length
      ? input.options.scaleGrid
      : DEFAULT_WALK_FORWARD.scaleGrid
    )
      .map((v) => Math.max(0, Math.min(4, v)))
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => a - b),
  };
  const params: ReplayParams = { ...DEFAULT_REPLAY_PARAMS, ...(input.params ?? {}) };
  const startEquity = input.startingEquity && input.startingEquity > 0 ? input.startingEquity : 10_000;

  const allDates = [
    ...new Set([...input.prices.values()].flatMap((s) => s.map((c) => c.date))),
  ].sort();
  const first = allDates[0] ?? "";
  const last = allDates[allDates.length - 1] ?? "";
  const symbols = [...input.prices.keys()];

  const empty = (label: string): OosArm => ({
    label,
    curve: [],
    totalReturnPct: 0,
    maxDrawdownPct: 0,
    sharpe: 0,
    var95Pct: 0,
    cvar95Pct: 0,
  });

  const folds = first && last ? planFolds(first, last, options) : [];
  const results: FoldResult[] = [];

  const baseCurve: Array<{ date: string; equity: number }> = [];
  const nudCurve: Array<{ date: string; equity: number }> = [];
  const baseRets: number[] = [];
  const nudRets: number[] = [];
  let baseEq = startEquity;
  let nudEq = startEquity;

  folds.forEach((f, i) => {
    // Training window: try each nudge strength, keep the best by objective.
    const trainPrices = slicePrices(input.prices, shiftDays(f.trainFrom, -options.warmupDays), f.trainTo);
    const trainEvents = sliceEvents(input.events, shiftDays(f.trainFrom, -60), f.trainTo);
    let chosenScale = 0;
    let trainScore = -Infinity;
    let trainDeltaPct = 0;
    for (const scale of options.scaleGrid) {
      const r = runNudgeReplay({
        prices: trainPrices,
        events: trainEvents,
        params: { ...params, nudgeScale: scale },
        startingEquity: startEquity,
        iterations: 200,
      });
      const score = objectiveOf(r, options.objective);
      if (score > trainScore) {
        chosenScale = scale;
        trainScore = score;
        trainDeltaPct = r.delta.returnPct;
      }
    }
    if (!Number.isFinite(trainScore)) trainScore = 0;

    // Evaluation window: the chosen strength, applied blind to fresh tape.
    const testPrices = slicePrices(input.prices, shiftDays(f.testFrom, -options.warmupDays), f.testTo);
    const testEvents = sliceEvents(input.events, shiftDays(f.testFrom, -60), f.testTo);
    const test = runNudgeReplay({
      prices: testPrices,
      events: testEvents,
      params: { ...params, nudgeScale: chosenScale },
      startingEquity: startEquity,
      iterations: 200,
    });

    // Only bars inside the evaluation window count toward the OOS curve.
    const baseWindow = test.baseline.curve.filter((c) => c.date >= f.testFrom && c.date <= f.testTo);
    const nudWindow = test.nudged.curve.filter((c) => c.date >= f.testFrom && c.date <= f.testTo);
    const compound = (
      window: typeof baseWindow,
      full: typeof baseWindow,
      eq: number,
      curve: Array<{ date: string; equity: number }>,
      rets: number[],
    ): number => {
      let running = eq;
      const startIdx = full.findIndex((c) => c.date === window[0]?.date);
      let prev =
        startIdx > 0 ? (full[startIdx - 1] as { equity: number }).equity : (window[0]?.equity ?? 1);
      for (const c of window) {
        const r = prev > 0 ? c.equity / prev - 1 : 0;
        running *= 1 + r;
        rets.push(r);
        curve.push({ date: c.date, equity: Number(running.toFixed(2)) });
        prev = c.equity;
      }
      return running;
    };
    const beforeBase = baseEq;
    const beforeNud = nudEq;
    baseEq = compound(baseWindow, test.baseline.curve, baseEq, baseCurve, baseRets);
    nudEq = compound(nudWindow, test.nudged.curve, nudEq, nudCurve, nudRets);

    results.push({
      index: i + 1,
      trainFrom: f.trainFrom,
      trainTo: f.trainTo,
      testFrom: f.testFrom,
      testTo: f.testTo,
      chosenScale,
      trainScore: Number(trainScore.toFixed(3)),
      trainDeltaPct,
      testBaselinePct: Number(((baseEq / beforeBase - 1) * 100).toFixed(3)),
      testNudgedPct: Number(((nudEq / beforeNud - 1) * 100).toFixed(3)),
      testDeltaPct: Number((((nudEq / beforeNud) - (baseEq / beforeBase)) * 100).toFixed(3)),
      testDays: baseWindow.length,
    });
  });

  const baseline = baseCurve.length ? armFrom("Baseline (no nudge)", baseCurve, baseRets, startEquity) : empty("Baseline (no nudge)");
  const nudged = nudCurve.length ? armFrom("Nudge (walk-forward tuned)", nudCurve, nudRets, startEquity) : empty("Nudge (walk-forward tuned)");

  const scored = results.filter((r) => r.testDays > 0);
  const wins = scored.filter((r) => r.testDeltaPct > 0).length;
  const foldWinRate = scored.length ? Number((wins / scored.length).toFixed(3)) : 0;
  const nonZeroScaleFolds = scored.filter((r) => r.chosenScale > 0).length;

  const delta = {
    returnPct: Number((nudged.totalReturnPct - baseline.totalReturnPct).toFixed(3)),
    maxDrawdownPct: Number((nudged.maxDrawdownPct - baseline.maxDrawdownPct).toFixed(3)),
    sharpe: Number((nudged.sharpe - baseline.sharpe).toFixed(2)),
    var95Pct: Number((nudged.var95Pct - baseline.var95Pct).toFixed(3)),
  };

  let verdict: WalkForwardResult["verdict"] = "neutral";
  if (scored.length < 2) verdict = "insufficient";
  else if (delta.returnPct > 0.5 && foldWinRate >= 0.5) verdict = "helps";
  else if (delta.returnPct < -0.5) verdict = "hurts";

  const summary =
    verdict === "insufficient"
      ? `Not enough history for a rolling test — ${options.trainMonths}m train + ${options.testMonths}m test needs at least ${options.trainMonths + options.testMonths * 2} months of tape.`
      : `${scored.length} out-of-sample windows (${options.trainMonths}m train → ${options.testMonths}m test). Nudge ${delta.returnPct >= 0 ? "added" : "cost"} ${Math.abs(delta.returnPct).toFixed(2)}pp versus baseline out of sample, winning ${wins}/${scored.length} folds; drawdown ${delta.maxDrawdownPct.toFixed(2)}pp and 95% VaR ${delta.var95Pct.toFixed(2)}pp different. Training picked a non-zero nudge in ${nonZeroScaleFolds}/${scored.length} folds.`;

  return {
    from: first,
    to: last,
    symbols,
    options,
    riskLevel: params.riskLevel,
    folds: results,
    baseline,
    nudged,
    delta,
    foldWinRate,
    nonZeroScaleFolds,
    verdict,
    summary,
  };
}
