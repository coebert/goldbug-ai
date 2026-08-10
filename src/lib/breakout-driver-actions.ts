import type { TopDriver } from "@/lib/breakout-diagnostics";

/**
 * Turns a ranked driver row into a recommended action under a chosen risk
 * setting. The ranking itself is tunable through the expectancy-gap weight
 * (see `topDrivers`); this layer only maps a ranked row to "what would I do
 * with this name", so the two controls compose:
 *   gap weight  → which names surface and in what order
 *   risk level  → how aggressively those names get acted on
 */
export type RiskLevel = "conservative" | "balanced" | "aggressive";

export type RiskProfile = {
  level: RiskLevel;
  label: string;
  /** Confidence below this forces a downsize rather than a full-size trade. */
  minConfidence: number;
  /** Score at or above this is promoted to "prioritise". */
  prioritiseAt: number;
  /** Score at or below this is dropped entirely. */
  avoidAt: number;
  /** Size applied when the row is traded at full conviction. */
  fullSize: number;
  /** Size applied when the row is kept but doubted. */
  downsize: number;
  /** Size applied to a prioritised row. */
  prioritySize: number;
};

export const RISK_PROFILES: Record<RiskLevel, RiskProfile> = {
  conservative: {
    level: "conservative",
    label: "Conservative",
    minConfidence: 0.66,
    prioritiseAt: 25,
    avoidAt: 0,
    fullSize: 0.7,
    downsize: 0.35,
    prioritySize: 0.9,
  },
  balanced: {
    level: "balanced",
    label: "Balanced",
    minConfidence: 0.5,
    prioritiseAt: 15,
    avoidAt: -5,
    fullSize: 1,
    downsize: 0.6,
    prioritySize: 1.25,
  },
  aggressive: {
    level: "aggressive",
    label: "Aggressive",
    minConfidence: 0.35,
    prioritiseAt: 8,
    avoidAt: -20,
    fullSize: 1.3,
    downsize: 0.85,
    prioritySize: 1.6,
  },
};

export const RISK_LEVELS: RiskLevel[] = ["conservative", "balanced", "aggressive"];

export type DriverAction = "prioritise" | "trade" | "downsize" | "avoid";

export type DriverRecommendation = {
  symbol: string;
  action: DriverAction;
  /** Size multiplier to apply versus the engine's baseline stake. */
  sizeMultiplier: number;
  reason: string;
};

export function recommendDriverAction(
  driver: TopDriver,
  level: RiskLevel,
): DriverRecommendation {
  const p = RISK_PROFILES[level];
  const conf = driver.confidence.score;
  const thin = conf < p.minConfidence;

  if (driver.score <= p.avoidAt) {
    return {
      symbol: driver.symbol,
      action: "avoid",
      sizeMultiplier: 0,
      reason: `score ${driver.score.toFixed(1)} at or below the ${p.label.toLowerCase()} floor of ${p.avoidAt} — stand aside`,
    };
  }

  if (driver.score >= p.prioritiseAt && !thin) {
    return {
      symbol: driver.symbol,
      action: "prioritise",
      sizeMultiplier: p.prioritySize,
      reason: `score ${driver.score.toFixed(1)} clears the ${p.prioritiseAt} priority bar on ${driver.confirmedTrades} confirmed signals, led by ${driver.lead}`,
    };
  }

  if (thin || driver.score < 0) {
    return {
      symbol: driver.symbol,
      action: "downsize",
      sizeMultiplier: p.downsize,
      reason: thin
        ? `confidence ${(conf * 100).toFixed(0)} below the ${(p.minConfidence * 100).toFixed(0)} bar for ${p.label.toLowerCase()} — take a partial`
        : `score ${driver.score.toFixed(1)} is negative but above the avoid floor — take a partial`,
    };
  }

  return {
    symbol: driver.symbol,
    action: "trade",
    sizeMultiplier: p.fullSize,
    reason: `score ${driver.score.toFixed(1)} with ${driver.confidence.label} confidence — trade at the ${p.label.toLowerCase()} baseline`,
  };
}

export function recommendDriverActions(
  drivers: readonly TopDriver[],
  level: RiskLevel,
): DriverRecommendation[] {
  return drivers.map((d) => recommendDriverAction(d, level));
}

/** One-line read of how the current settings shape the action mix. */
export function summariseActions(recs: readonly DriverRecommendation[], level: RiskLevel): string {
  if (!recs.length) return "No ranked drivers under these settings.";
  const count = (a: DriverAction) => recs.filter((r) => r.action === a).length;
  return `${RISK_PROFILES[level].label}: ${count("prioritise")} prioritise · ${count("trade")} trade · ${count("downsize")} downsize · ${count("avoid")} avoid`;
}
