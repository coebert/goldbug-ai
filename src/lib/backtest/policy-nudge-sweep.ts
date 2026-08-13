// Sensitivity sweep over the two dials that define the policy nudge:
//
//   nudgeScale  — how strong the fixed nudge is (0 = policy-deaf baseline)
//   regimeGain  — how far the market-regime read is allowed to stretch it
//                 (0 = regime arm collapses onto the fixed nudge, 1 = live)
//
// Each cell replays the SAME tape and headlines through `runPolicyNudgeReplay`
// and reports the regime arm measured against the fixed-nudge arm at that
// strength, so the grid answers "where does regime-aware scaling actually keep
// outperforming, and where is it just noise?".
//
// Pure: no network, no database. Prices and headlines are injected.

import {
  runPolicyNudgeReplay,
  type PolicyArmDelta,
  type PolicyConfidenceBand,
  type PolicyReplayInput,
  type PolicyReplayParams,
} from "./policy-nudge-replay";

export type PolicySweepCell = {
  nudgeScale: number;
  regimeGain: number;
  /** Absolute returns of the three arms at this cell, %. */
  baselineReturnPct: number;
  fixedReturnPct: number;
  regimeReturnPct: number;
  fixedDrawdownPct: number;
  regimeDrawdownPct: number;
  regimeSharpe: number;
  /** Regime arm vs the fixed nudge at the same strength. */
  vsFixed: PolicyArmDelta;
  vsFixedConfidence: PolicyConfidenceBand;
  /** Regime arm vs the policy-deaf baseline. */
  vsBaselineReturnPct: number;
  avgScale: number;
  scaledDays: number;
  /** True when the 95% CI on the vs-fixed return delta excludes zero. */
  significant: boolean;
  /** Signed classification used for the heatmap. */
  outcome: "wins" | "leans_win" | "flat" | "leans_loss" | "loses" | "inactive";
};

export type PolicySweepResult = {
  from: string;
  to: string;
  symbols: string[];
  tradingDays: number;
  nudgeScales: number[];
  regimeGains: number[];
  cells: PolicySweepCell[];
  /** Cell with the best vs-fixed return delta (ties broken by drawdown). */
  best: PolicySweepCell | null;
  /** Cells where regime scaling beat the fixed nudge, of those evaluated. */
  winCount: number;
  robustCount: number;
  summary: string;
};

export type PolicySweepInput = Omit<PolicyReplayInput, "params"> & {
  params?: Partial<PolicyReplayParams>;
  nudgeScales?: readonly number[];
  regimeGains?: readonly number[];
};

export const DEFAULT_SWEEP_NUDGE_SCALES = [0.5, 1, 1.5, 2] as const;
export const DEFAULT_SWEEP_REGIME_GAINS = [0, 0.5, 1, 1.5, 2] as const;

const round = (v: number, dp = 3) => Number(v.toFixed(dp));

function classify(cell: {
  scaledDays: number;
  significant: boolean;
  returnDelta: number;
}): PolicySweepCell["outcome"] {
  if (cell.scaledDays === 0) return "inactive";
  if (cell.significant) return cell.returnDelta > 0 ? "wins" : "loses";
  if (Math.abs(cell.returnDelta) < 0.25) return "flat";
  return cell.returnDelta > 0 ? "leans_win" : "leans_loss";
}

/**
 * Run the grid. Bootstrap iterations default lower than a single replay: the
 * grid multiplies work by cell count, and cells only need enough resamples to
 * separate signal from noise, not a publication-grade interval.
 */
export function runPolicyNudgeSweep(input: PolicySweepInput): PolicySweepResult {
  const nudgeScales = [...(input.nudgeScales?.length ? input.nudgeScales : DEFAULT_SWEEP_NUDGE_SCALES)]
    .map((v) => round(Math.max(0, Math.min(4, v)), 2))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);
  const regimeGains = [...(input.regimeGains?.length ? input.regimeGains : DEFAULT_SWEEP_REGIME_GAINS)]
    .map((v) => round(Math.max(0, Math.min(4, v)), 2))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);

  const iterations = Math.max(200, Math.min(2000, input.iterations ?? 400));
  const cells: PolicySweepCell[] = [];
  let from = "";
  let to = "";
  let symbols: string[] = [];
  let tradingDays = 0;

  for (const nudgeScale of nudgeScales) {
    for (const regimeGain of regimeGains) {
      const r = runPolicyNudgeReplay({
        prices: input.prices,
        news: input.news,
        startingEquity: input.startingEquity,
        iterations,
        // Same seed on every cell: the grid compares dials, not bootstrap luck.
        seed: input.seed ?? 20260813,
        params: { ...(input.params ?? {}), nudgeScale, regimeGain },
      });
      from = r.from;
      to = r.to;
      symbols = r.symbols;
      tradingDays = r.tradingDays;

      const vsFixed = r.regimeVsFixed.delta;
      const band = r.regimeVsFixed.confidence;
      const significant =
        band.iterations > 0 && (band.returnDeltaLo > 0 || band.returnDeltaHi < 0);
      cells.push({
        nudgeScale,
        regimeGain,
        baselineReturnPct: r.baseline.totalReturnPct,
        fixedReturnPct: r.nudged.totalReturnPct,
        regimeReturnPct: r.regime.totalReturnPct,
        fixedDrawdownPct: r.nudged.maxDrawdownPct,
        regimeDrawdownPct: r.regime.maxDrawdownPct,
        regimeSharpe: r.regime.sharpe,
        vsFixed,
        vsFixedConfidence: band,
        vsBaselineReturnPct: r.regimeVsBaseline.delta.returnPct,
        avgScale: r.regimeAttribution.avgScale,
        scaledDays: r.regimeAttribution.scaledDays,
        significant,
        outcome: classify({
          scaledDays: r.regimeAttribution.scaledDays,
          significant,
          returnDelta: vsFixed.returnPct,
        }),
      });
    }
  }

  const live = cells.filter((c) => c.scaledDays > 0 && c.regimeGain > 0);
  const best =
    live.length === 0
      ? null
      : [...live].sort(
          (a, b) =>
            b.vsFixed.returnPct - a.vsFixed.returnPct ||
            b.vsFixed.maxDrawdownPct - a.vsFixed.maxDrawdownPct,
        )[0] ?? null;
  const winCount = live.filter((c) => c.vsFixed.returnPct > 0).length;
  const robustCount = live.filter((c) => c.outcome === "wins").length;

  const summary =
    live.length === 0
      ? "Regime scaling never engaged on this tape, so every cell is identical to the fixed nudge — backfill more policy headlines before reading the grid."
      : `Across ${live.length} live cells (${nudgeScales.length} nudge strengths × ${regimeGains.filter((g) => g > 0).length} regime gains), regime-aware scaling beat the fixed nudge in ${winCount} (${((winCount / live.length) * 100).toFixed(0)}%), and did so with a 95% interval clear of zero in ${robustCount}. Best cell: nudge ×${best?.nudgeScale.toFixed(1)} with gain ×${best?.regimeGain.toFixed(1)}, ${(best?.vsFixed.returnPct ?? 0) >= 0 ? "+" : ""}${best?.vsFixed.returnPct.toFixed(2)}pp versus the fixed nudge and drawdown ${(best?.vsFixed.maxDrawdownPct ?? 0) >= 0 ? "shallower" : "deeper"} by ${Math.abs(best?.vsFixed.maxDrawdownPct ?? 0).toFixed(2)}pp.${
          robustCount === 0
            ? " No cell clears significance, so treat the surface as a stability check rather than a tuning result."
            : ""
        }`;

  return {
    from,
    to,
    symbols,
    tradingDays,
    nudgeScales,
    regimeGains,
    cells,
    best,
    winCount,
    robustCount,
    summary,
  };
}
