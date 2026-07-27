// Historical backtest for candidate algo-regime configs.
//
// Pure module: given the per-day microstructure inputs already gathered
// once (SPY closes/volumes, optional holdings cross-section) and an
// equity curve, re-classify every day under a candidate `AlgoRegimeConfig`
// and compute the forward-return + drawdown profile per tier. Callers own
// I/O; this file is I/O free so it stays trivially fuzz-testable.

import {
  detectAlgoRegime,
  type AlgoRegimeConfig,
  type AlgoRegimeSnapshot,
  type AlgoRegimeTier,
  type BarSeries,
} from "./algo-regime";
import {
  calibrateRegime,
  type CalibrationReport,
  type EquityPoint,
  type RegimeObservation,
} from "./algo-regime-calibration";

export type DailyRegimeInput = {
  /** ISO date the snapshot represents. */
  date: string;
  primary: BarSeries;
  crossSection?: Record<string, number[]>;
  overnightGapPct?: number;
  openingFadePct?: number;
};

export type TierBacktest = {
  tier: AlgoRegimeTier;
  count: number;
  meanReturn: number;
  hitRate: number;
  worstReturn: number;
  /** Peak-to-trough drawdown of a synthetic curve compounding only
   *  the forward returns of days classified into this tier.
   *  Value is a non-positive fraction (e.g. -0.087 = -8.7%). */
  maxDrawdown: number;
};

export type ConfigBacktest = {
  label: string;
  config: AlgoRegimeConfig;
  perTier: TierBacktest[];
  matched: number;
  unmatched: number;
  monotone: boolean;
  /** Fraction of matched days the guard would have blocked new buys. */
  blockedDayShare: number;
  /** Compound forward return across all matched days, as a sanity anchor. */
  totalForwardReturn: number;
};

const TIERS: AlgoRegimeTier[] = ["normal", "elevated", "extreme"];

function maxDrawdown(returns: readonly number[]): number {
  if (returns.length === 0) return 0;
  let equity = 1;
  let peak = 1;
  let dd = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const cur = equity / peak - 1;
    if (cur < dd) dd = cur;
  }
  return dd;
}

/**
 * Re-classify each historical day under `config` and compute per-tier
 * realised forward-return + drawdown stats against the given equity curve.
 */
export function simulateAlgoRegimeConfig(
  perDay: readonly DailyRegimeInput[],
  equity: readonly EquityPoint[],
  config: AlgoRegimeConfig,
  label = "candidate",
): ConfigBacktest {
  const observations: RegimeObservation[] = [];
  const snapshots = new Map<string, AlgoRegimeSnapshot>();

  for (const day of perDay) {
    const snap = detectAlgoRegime({
      primary: day.primary,
      crossSection: day.crossSection,
      overnightGapPct: day.overnightGapPct,
      openingFadePct: day.openingFadePct,
      config,
    });
    snapshots.set(day.date, snap);
    observations.push({ date: day.date, tier: snap.tier });
  }

  const report: CalibrationReport = calibrateRegime(observations, equity);

  // Build ordered forward-return series per tier for drawdown math.
  const sortedEquity = [...equity]
    .filter((p) => Number.isFinite(p.totalValue) && p.totalValue > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const buckets: Record<AlgoRegimeTier, number[]> = {
    normal: [], elevated: [], extreme: [],
  };
  const sortedObs = [...observations].sort((a, b) => a.date.localeCompare(b.date));
  for (const obs of sortedObs) {
    let baseIdx = -1;
    for (let i = 0; i < sortedEquity.length; i++) {
      if (sortedEquity[i].date <= obs.date) baseIdx = i;
      else break;
    }
    if (baseIdx < 0 || baseIdx >= sortedEquity.length - 1) continue;
    const base = sortedEquity[baseIdx].totalValue;
    const next = sortedEquity[baseIdx + 1].totalValue;
    if (!(base > 0)) continue;
    const ret = (next - base) / base;
    if (!Number.isFinite(ret)) continue;
    buckets[obs.tier].push(ret);
  }

  const perTier: TierBacktest[] = TIERS.map((tier) => {
    const stat = report.perTier.find((t) => t.tier === tier)!;
    return {
      tier,
      count: stat.count,
      meanReturn: stat.meanReturn,
      hitRate: stat.hitRate,
      worstReturn: stat.worstReturn,
      maxDrawdown: maxDrawdown(buckets[tier]),
    };
  });

  const totalReturns = ([] as number[]).concat(
    buckets.normal, buckets.elevated, buckets.extreme,
  );
  const totalForwardReturn = totalReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;

  const blockedDays = observations.filter(
    (o) => snapshots.get(o.date)?.multipliers.blockNewBuys,
  ).length;
  const blockedDayShare = observations.length > 0
    ? blockedDays / observations.length
    : 0;

  return {
    label,
    config,
    perTier,
    matched: report.matched,
    unmatched: report.unmatched,
    monotone: report.monotone,
    blockedDayShare,
    totalForwardReturn,
  };
}

export type BacktestComparison = {
  baseline: ConfigBacktest;
  candidate: ConfigBacktest;
  /** Per-tier deltas (candidate − baseline) in mean forward return and
   *  drawdown, so the UI can highlight regressions without recomputing. */
  deltas: Array<{
    tier: AlgoRegimeTier;
    meanReturnDelta: number;
    maxDrawdownDelta: number;
    countDelta: number;
  }>;
  /** True when candidate keeps the ladder monotone AND does not worsen
   *  extreme drawdown by more than 50bps vs baseline. Callers use this
   *  as a green-light hint before scheduling shadow evaluation. */
  safeToSchedule: boolean;
  reason: string;
};

/**
 * Compare two configs on the same historical inputs so an operator can see
 * exactly how the candidate would have altered classification/outcomes
 * before scheduling it for shadow evaluation.
 */
export function compareAlgoRegimeConfigs(
  perDay: readonly DailyRegimeInput[],
  equity: readonly EquityPoint[],
  baselineConfig: AlgoRegimeConfig,
  candidateConfig: AlgoRegimeConfig,
): BacktestComparison {
  const baseline = simulateAlgoRegimeConfig(perDay, equity, baselineConfig, "baseline");
  const candidate = simulateAlgoRegimeConfig(perDay, equity, candidateConfig, "candidate");

  const deltas = TIERS.map((tier) => {
    const b = baseline.perTier.find((t) => t.tier === tier)!;
    const c = candidate.perTier.find((t) => t.tier === tier)!;
    return {
      tier,
      meanReturnDelta: c.meanReturn - b.meanReturn,
      maxDrawdownDelta: c.maxDrawdown - b.maxDrawdown,
      countDelta: c.count - b.count,
    };
  });

  const extremeDelta = deltas.find((d) => d.tier === "extreme")!;
  const worsensExtreme = extremeDelta.maxDrawdownDelta < -0.005;
  const inverted = !candidate.monotone && baseline.monotone;
  const safeToSchedule = !worsensExtreme && !inverted;
  const reasons: string[] = [];
  if (worsensExtreme) {
    reasons.push(
      `extreme-tier drawdown worsens ${(extremeDelta.maxDrawdownDelta * 100).toFixed(2)}pp`,
    );
  }
  if (inverted) reasons.push("candidate breaks the monotone tier ladder");
  if (reasons.length === 0) reasons.push("candidate preserves ladder & tail-risk profile");

  return { baseline, candidate, deltas, safeToSchedule, reason: reasons.join("; ") };
}
