// Phase G — Calibration. Pure analytics that take historical algo-regime tier
// observations and portfolio equity snapshots, and produce per-tier realised
// forward-return statistics so we can judge whether the guard's tier ladder
// (normal / elevated / extreme) actually predicts worse next-day outcomes.
//
// Everything here is I/O free so it's easy to unit-test and safe to import
// from server function modules.

import type { AlgoRegimeTier } from "@/lib/microstructure/algo-regime";

export type RegimeObservation = {
  /** ISO date (yyyy-mm-dd) the snapshot was taken on. */
  date: string;
  tier: AlgoRegimeTier;
};

export type EquityPoint = {
  /** ISO date (yyyy-mm-dd). */
  date: string;
  totalValue: number;
};

export type TierStats = {
  tier: AlgoRegimeTier;
  count: number;
  /** Mean next-period return (fraction, e.g. 0.01 = +1%). */
  meanReturn: number;
  /** Standard deviation of next-period returns. */
  stdReturn: number;
  /** Fraction of observations with strictly positive next-period return. */
  hitRate: number;
  /** Worst observed next-period return in the sample. */
  worstReturn: number;
};

export type CalibrationReport = {
  perTier: TierStats[];
  /**
   * `true` when the tier ladder is monotone in the expected direction:
   * mean(normal) ≥ mean(elevated) ≥ mean(extreme). Only meaningful when
   * every tier has at least one observation.
   */
  monotone: boolean;
  /** Total observations that produced a forward return. */
  matched: number;
  /** Observations that were dropped (no next equity point available). */
  unmatched: number;
};

const TIERS: AlgoRegimeTier[] = ["normal", "elevated", "extreme"];

/**
 * Join observations with the next available equity point strictly after the
 * observation date and compute per-tier realised forward-return stats.
 */
export function calibrateRegime(
  observations: readonly RegimeObservation[],
  equity: readonly EquityPoint[],
): CalibrationReport {
  const sortedEquity = [...equity]
    .filter((p) => Number.isFinite(p.totalValue) && p.totalValue > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const buckets: Record<AlgoRegimeTier, number[]> = {
    normal: [],
    elevated: [],
    extreme: [],
  };
  let matched = 0;
  let unmatched = 0;

  for (const obs of observations) {
    // Baseline: last equity point ON OR BEFORE the observation date.
    let baseIdx = -1;
    for (let i = 0; i < sortedEquity.length; i++) {
      if (sortedEquity[i].date <= obs.date) baseIdx = i;
      else break;
    }
    if (baseIdx < 0 || baseIdx >= sortedEquity.length - 1) {
      unmatched++;
      continue;
    }
    const base = sortedEquity[baseIdx].totalValue;
    const next = sortedEquity[baseIdx + 1].totalValue;
    if (!(base > 0)) {
      unmatched++;
      continue;
    }
    const ret = (next - base) / base;
    if (!Number.isFinite(ret)) {
      unmatched++;
      continue;
    }
    buckets[obs.tier].push(ret);
    matched++;
  }

  const perTier: TierStats[] = TIERS.map((tier) => {
    const rs = buckets[tier];
    if (rs.length === 0) {
      return {
        tier,
        count: 0,
        meanReturn: 0,
        stdReturn: 0,
        hitRate: 0,
        worstReturn: 0,
      };
    }
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const variance =
      rs.length > 1
        ? rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rs.length - 1)
        : 0;
    const hits = rs.filter((r) => r > 0).length;
    const worst = rs.reduce((a, b) => Math.min(a, b), rs[0]);
    return {
      tier,
      count: rs.length,
      meanReturn: mean,
      stdReturn: Math.sqrt(variance),
      hitRate: hits / rs.length,
      worstReturn: worst,
    };
  });

  const monotone =
    perTier.every((t) => t.count > 0) &&
    perTier[0].meanReturn >= perTier[1].meanReturn &&
    perTier[1].meanReturn >= perTier[2].meanReturn;

  return { perTier, monotone, matched, unmatched };
}
