// Phase 3 item 11 — adaptive alpha weights.
//
// The regime matrix gives every model a *prior* weight. This module turns
// realised performance (hit rate + edge) into a bounded multiplier on that
// prior, so a model that has been paying keeps its weight and one that has
// been bleeding gets shrunk — without ever letting a short run of luck take
// over the book.
//
// Design rules:
//   - Multiplier is bounded to [MIN_MULT, MAX_MULT] (0.5x .. 1.5x).
//   - Evidence is shrunk toward 1.0 by sample count (credibility weighting),
//     so a 3-sample model barely moves.
//   - Hit rate and average edge are blended; edge dominates because a 45%
//     hit rate with fat winners is still a good model.
//   - Pure and side-effect free: all persistence lives in the .server file.
import type { AlphaModelKind } from "./types";
import type { StrategyWeights } from "./regime-matrix";

export const MIN_MULT = 0.5;
export const MAX_MULT = 1.5;

/** Samples needed before evidence is taken at full credibility. */
export const FULL_CREDIBILITY_SAMPLES = 40;

/** Edge (bps) that maps to the full positive adjustment. */
const EDGE_SCALE_BPS = 120;

export type ModelPerformance = {
  model_kind: AlphaModelKind;
  samples: number;
  hit_rate: number | null;
  avg_edge_bps: number | null;
};

export type ModelMultiplier = {
  model_kind: AlphaModelKind;
  multiplier: number;
  credibility: number;
  raw_signal: number;
  reason: string;
};

const KINDS: AlphaModelKind[] = ["trend", "mean_reversion", "quality", "carry", "breakout"];

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Credibility in [0, 1]: sqrt-scaled sample count, so evidence accrues fast
 * early and then flattens.
 */
export function credibility(samples: number): number {
  const n = Math.max(0, Number(samples) || 0);
  return clamp(Math.sqrt(n / FULL_CREDIBILITY_SAMPLES), 0, 1);
}

/**
 * Raw performance signal in [-1, 1] from hit rate and average edge.
 * Hit rate contributes 40%, edge 60%.
 */
export function performanceSignal(perf: ModelPerformance): number {
  const hr = perf.hit_rate == null || !Number.isFinite(perf.hit_rate) ? null : perf.hit_rate;
  const edge = perf.avg_edge_bps == null || !Number.isFinite(perf.avg_edge_bps) ? null : perf.avg_edge_bps;
  if (hr == null && edge == null) return 0;
  const hrSignal = hr == null ? 0 : clamp((hr - 0.5) / 0.2, -1, 1);
  const edgeSignal = edge == null ? 0 : clamp(edge / EDGE_SCALE_BPS, -1, 1);
  const hrWeight = hr == null ? 0 : 0.4;
  const edgeWeight = edge == null ? 0 : 0.6;
  const total = hrWeight + edgeWeight;
  if (total <= 0) return 0;
  return clamp((hrSignal * hrWeight + edgeSignal * edgeWeight) / total, -1, 1);
}

/** Bounded, credibility-shrunk multiplier for a single model. */
export function multiplierFor(perf: ModelPerformance): ModelMultiplier {
  const cred = credibility(perf.samples);
  const raw = performanceSignal(perf);
  const span = raw >= 0 ? MAX_MULT - 1 : 1 - MIN_MULT;
  const multiplier = clamp(1 + raw * span * cred, MIN_MULT, MAX_MULT);
  const reason =
    cred <= 0
      ? "no samples — prior unchanged"
      : `${perf.samples} samples, hit=${perf.hit_rate == null ? "n/a" : (perf.hit_rate * 100).toFixed(0) + "%"}` +
        `, edge=${perf.avg_edge_bps == null ? "n/a" : perf.avg_edge_bps.toFixed(0) + "bps"}` +
        ` → ×${multiplier.toFixed(2)} (cred ${(cred * 100).toFixed(0)}%)`;
  return { model_kind: perf.model_kind, multiplier, credibility: cred, raw_signal: raw, reason };
}

/** Multipliers for every model kind; missing rows default to 1.0. */
export function computeModelMultipliers(
  rows: ModelPerformance[],
): Record<AlphaModelKind, ModelMultiplier> {
  const byKind = new Map(rows.map((r) => [r.model_kind, r]));
  const out = {} as Record<AlphaModelKind, ModelMultiplier>;
  for (const kind of KINDS) {
    const row = byKind.get(kind) ?? { model_kind: kind, samples: 0, hit_rate: null, avg_edge_bps: null };
    out[kind] = multiplierFor(row);
  }
  return out;
}

export type AdaptiveWeightRow = {
  model_kind: AlphaModelKind;
  base_weight: number;
  multiplier: number;
  effective_weight: number;
  reason: string;
};

/**
 * Apply multipliers to the regime prior and renormalise so the weights
 * still sum to 1. Models the regime disabled (base weight 0) stay at 0 —
 * adaptation never re-enables a strategy the regime switched off.
 */
export function applyAdaptiveWeights(
  base: StrategyWeights,
  mults: Partial<Record<AlphaModelKind, ModelMultiplier>>,
): { weights: StrategyWeights; rows: AdaptiveWeightRow[] } {
  const scaled = {} as StrategyWeights;
  let total = 0;
  for (const kind of KINDS) {
    const b = Math.max(0, Number(base[kind] ?? 0));
    const m = b > 0 ? (mults[kind]?.multiplier ?? 1) : 1;
    const v = b * m;
    scaled[kind] = v;
    total += v;
  }
  const weights = {} as StrategyWeights;
  for (const kind of KINDS) {
    weights[kind] = total > 0 ? scaled[kind] / total : Number(base[kind] ?? 0);
  }
  const rows: AdaptiveWeightRow[] = KINDS.map((kind) => ({
    model_kind: kind,
    base_weight: Number(base[kind] ?? 0),
    multiplier: Number(base[kind] ?? 0) > 0 ? (mults[kind]?.multiplier ?? 1) : 1,
    effective_weight: weights[kind],
    reason: mults[kind]?.reason ?? "no evidence",
  }));
  return { weights, rows };
}

/** One-line audit summary of what adaptation did. */
export function describeAdaptiveWeights(rows: AdaptiveWeightRow[]): string {
  const moved = rows.filter((r) => Math.abs(r.multiplier - 1) > 0.02);
  if (moved.length === 0) return "adaptive weights: no change (insufficient evidence)";
  return (
    "adaptive weights: " +
    moved
      .map((r) => `${r.model_kind} ×${r.multiplier.toFixed(2)}→${(r.effective_weight * 100).toFixed(0)}%`)
      .join(" ")
  );
}
