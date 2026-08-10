import { topDrivers } from "@/lib/breakout-diagnostics";
import type { DriverConfidenceLabel, SymbolDiagnostic, TopDriver } from "@/lib/breakout-diagnostics";
import {
  recommendDriverAction,
  type DriverAction,
  type RiskLevel,
} from "@/lib/breakout-driver-actions";
import type { DriverSetting } from "@/lib/breakout-driver-compare";

/**
 * Action-mix breakdown for the ranked driver set at a given (risk, gap weight)
 * setting: how many names the engine would buy, hold at a partial, or stand
 * aside on, and how that splits by confidence bucket.
 */
export type DriverStance = "buy" | "hold" | "sell";

export const ACTION_STANCE: Record<DriverAction, DriverStance> = {
  prioritise: "buy",
  trade: "buy",
  downsize: "hold",
  avoid: "sell",
};

export const STANCES: readonly DriverStance[] = ["buy", "hold", "sell"] as const;
export const ACTIONS: readonly DriverAction[] = [
  "prioritise",
  "trade",
  "downsize",
  "avoid",
] as const;
export const CONFIDENCE_LABELS: readonly DriverConfidenceLabel[] = [
  "high",
  "medium",
  "low",
] as const;

export type MixBucket = { count: number; pct: number; sizeSum: number };

export type ActionMix = {
  setting: DriverSetting;
  total: number;
  byAction: Record<DriverAction, MixBucket>;
  byStance: Record<DriverStance, MixBucket>;
  byConfidence: Record<DriverConfidenceLabel, MixBucket>;
  /** Sum of size multipliers across the ranked set (capital units at 1× each). */
  sizeSum: number;
  /** Mean size multiplier across the ranked set. */
  avgSize: number;
  summary: string;
};

const emptyBucket = (): MixBucket => ({ count: 0, pct: 0, sizeSum: 0 });

function blank<K extends string>(keys: readonly K[]): Record<K, MixBucket> {
  return Object.fromEntries(keys.map((k) => [k, emptyBucket()])) as Record<K, MixBucket>;
}

export function actionMix(
  drivers: readonly TopDriver[],
  setting: DriverSetting,
): ActionMix {
  const byAction = blank(ACTIONS);
  const byStance = blank(STANCES);
  const byConfidence = blank(CONFIDENCE_LABELS);
  let sizeSum = 0;

  for (const d of drivers) {
    const rec = recommendDriverAction(d, setting.risk);
    const stance = ACTION_STANCE[rec.action];
    sizeSum += rec.sizeMultiplier;
    for (const b of [byAction[rec.action], byStance[stance], byConfidence[d.confidence.label]]) {
      b.count += 1;
      b.sizeSum += rec.sizeMultiplier;
    }
  }

  const total = drivers.length;
  for (const rec of [byAction, byStance, byConfidence]) {
    for (const b of Object.values(rec) as MixBucket[]) {
      b.pct = total ? (b.count / total) * 100 : 0;
    }
  }

  const summary = total
    ? `${byStance.buy.count} buy · ${byStance.hold.count} partial · ${byStance.sell.count} stand aside at ${setting.risk} · ${setting.gapWeight}× gap, average size ${(sizeSum / total).toFixed(2)}×`
    : "No ranked drivers under these settings.";

  return {
    setting,
    total,
    byAction,
    byStance,
    byConfidence,
    sizeSum,
    avgSize: total ? sizeSum / total : 0,
    summary,
  };
}

/** Rank the symbols at `setting` then break the recommendations down. */
export function actionMixFor(
  symbols: readonly SymbolDiagnostic[],
  setting: DriverSetting,
  options: { minConfirmed?: number } = {},
): ActionMix {
  const ranked = topDrivers(symbols, {
    limit: 10_000,
    minConfirmed: options.minConfirmed ?? 3,
    gapWeight: setting.gapWeight,
  });
  return actionMix([...ranked.positive, ...ranked.negative], setting);
}

export type MixDelta = { count: number; pct: number };

export type ActionMixDiff = {
  from: ActionMix;
  to: ActionMix;
  byAction: Record<DriverAction, MixDelta>;
  byStance: Record<DriverStance, MixDelta>;
  byConfidence: Record<DriverConfidenceLabel, MixDelta>;
  avgSizeDelta: number;
  summary: string;
};

function deltaOf<K extends string>(
  keys: readonly K[],
  from: Record<K, MixBucket>,
  to: Record<K, MixBucket>,
): Record<K, MixDelta> {
  return Object.fromEntries(
    keys.map((k) => [k, { count: to[k].count - from[k].count, pct: to[k].pct - from[k].pct }]),
  ) as Record<K, MixDelta>;
}

export function diffActionMix(from: ActionMix, to: ActionMix): ActionMixDiff {
  const byStance = deltaOf(STANCES, from.byStance, to.byStance);
  const avgSizeDelta = to.avgSize - from.avgSize;
  const moved = STANCES.filter((s) => byStance[s].count !== 0);
  const summary = moved.length
    ? `${moved
        .map((s) => `${byStance[s].count > 0 ? "+" : ""}${byStance[s].count} ${s}`)
        .join(" · ")} · average size ${avgSizeDelta >= 0 ? "+" : ""}${avgSizeDelta.toFixed(2)}×`
    : `Same stance mix; average size ${avgSizeDelta >= 0 ? "+" : ""}${avgSizeDelta.toFixed(2)}×`;

  return {
    from,
    to,
    byAction: deltaOf(ACTIONS, from.byAction, to.byAction),
    byStance,
    byConfidence: deltaOf(CONFIDENCE_LABELS, from.byConfidence, to.byConfidence),
    avgSizeDelta,
    summary,
  };
}
