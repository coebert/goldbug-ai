// Phase 4 — Regime → strategy-weight matrix.
//
// Weights sum to 1 per regime and represent how much of the composite
// score each model contributes. When no regime is detected we fall back
// to a balanced blend that leans on trend + quality.
//
// The regime name is normalised (lowercased, spaces collapsed) before
// lookup so upstream detectors can use either snake_case or human labels.
import type { AlphaModelKind } from "./types";

export type RegimeName =
  | "risk_on"
  | "risk_off"
  | "high_vol"
  | "low_vol"
  | "trending"
  | "range_bound"
  | "unknown";

export type StrategyWeights = Record<AlphaModelKind, number>;

const MATRIX: Record<RegimeName, StrategyWeights> = {
  // Broad up-trend, low fear — lean into trend + quality, dip-buying
  // still helps but carry is dead weight.
  risk_on:     { trend: 0.50, mean_reversion: 0.20, quality: 0.25, carry: 0.05 },
  // Defensive — quality + carry dominate, cut trend exposure, keep a
  // small mean-reversion tilt for capitulation dip-buys.
  risk_off:    { trend: 0.10, mean_reversion: 0.20, quality: 0.40, carry: 0.30 },
  // Vol spikes — trend gets whipsawed, MR gets hurt by knives, quality
  // + carry survive best.
  high_vol:    { trend: 0.15, mean_reversion: 0.15, quality: 0.40, carry: 0.30 },
  // Calm tape — trend and MR both work, carry rewarded.
  low_vol:     { trend: 0.35, mean_reversion: 0.25, quality: 0.25, carry: 0.15 },
  // Directional — trend dominates.
  trending:    { trend: 0.60, mean_reversion: 0.10, quality: 0.25, carry: 0.05 },
  // Range-bound — MR dominates.
  range_bound: { trend: 0.10, mean_reversion: 0.55, quality: 0.25, carry: 0.10 },
  // Fallback — balanced.
  unknown:     { trend: 0.35, mean_reversion: 0.20, quality: 0.30, carry: 0.15 },
};

const ALIASES: Record<string, RegimeName> = {
  bull: "risk_on", risk_on: "risk_on", "risk on": "risk_on",
  bear: "risk_off", risk_off: "risk_off", "risk off": "risk_off",
  high_vol: "high_vol", volatile: "high_vol", "high vol": "high_vol",
  low_vol: "low_vol", calm: "low_vol", "low vol": "low_vol",
  trending: "trending", trend: "trending",
  range_bound: "range_bound", range: "range_bound", choppy: "range_bound",
};

export function resolveRegime(raw: string | null | undefined): RegimeName {
  if (!raw) return "unknown";
  const key = String(raw).toLowerCase().replace(/\s+/g, " ").trim();
  return ALIASES[key] ?? (key in MATRIX ? (key as RegimeName) : "unknown");
}

export function weightsForRegime(raw: string | null | undefined): StrategyWeights {
  return MATRIX[resolveRegime(raw)];
}
