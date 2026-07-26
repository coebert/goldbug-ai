// Phase 6 — Tail hedge overlay.
//
// Small, always-on convex hedge (e.g. long-vol / SPY put spreads) sized as a
// fraction of NAV. Sizing is regime- and valuation-aware:
//   - Higher CAPE / stretched valuations → bigger hedge (cheap insurance
//     matters most when the tape is priced for perfection).
//   - risk_off / high_vol → cut the hedge (vol is already rich; premium
//     bleed dominates).
//   - risk_on / trending / low_vol → normal sizing.
//   - unknown / range_bound → normal sizing.
//
// This module is pure: given inputs it returns a target hedge notional and
// a delta vs the current hedge notional (buy / sell / hold). Execution
// belongs to the caller.

import type { RegimeName } from "@/lib/alpha/regime-matrix";
import { resolveRegime } from "@/lib/alpha/regime-matrix";

export type TailHedgeConfig = {
  /** Baseline hedge as a fraction of NAV when CAPE is at the neutral anchor. */
  baselinePctNav: number; // default 0.01 (1%)
  /** Hard cap on hedge as a fraction of NAV. */
  maxPctNav: number; // default 0.03 (3%)
  /** CAPE below this → hedge fully off (0). */
  capeFloor: number; // default 18
  /** CAPE at/above this → hedge at maxPctNav. */
  capeCap: number; // default 38
  /** Minimum rebalance delta (fraction of NAV) to avoid churn. */
  rebalanceThresholdPctNav: number; // default 0.0025 (25 bps of NAV)
};

export const DEFAULT_TAIL_HEDGE_CONFIG: TailHedgeConfig = {
  baselinePctNav: 0.01,
  maxPctNav: 0.03,
  capeFloor: 18,
  capeCap: 38,
  rebalanceThresholdPctNav: 0.0025,
};

const REGIME_MULT: Record<RegimeName, number> = {
  risk_on: 1.0,
  risk_off: 0.25, // vol already rich, cut premium bleed
  high_vol: 0.25,
  low_vol: 1.1,
  trending: 1.0,
  range_bound: 1.0,
  unknown: 1.0,
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export type TailHedgeInputs = {
  nav: number;
  cape: number | null | undefined;
  regime: string | null | undefined;
  currentHedgeNotional: number; // >= 0
  config?: Partial<TailHedgeConfig>;
};

export type TailHedgeDecision = {
  action: "buy" | "sell" | "hold";
  targetNotional: number;
  deltaNotional: number; // + = buy hedge, - = sell hedge
  targetPctNav: number;
  regime: RegimeName;
  reason: string;
};

/**
 * Compute the target tail-hedge notional and the rebalance delta.
 */
export function computeTailHedge(inputs: TailHedgeInputs): TailHedgeDecision {
  const cfg: TailHedgeConfig = { ...DEFAULT_TAIL_HEDGE_CONFIG, ...(inputs.config ?? {}) };
  const regime = resolveRegime(inputs.regime);
  const nav = Number.isFinite(inputs.nav) && inputs.nav > 0 ? inputs.nav : 0;
  const cur = Math.max(0, Number.isFinite(inputs.currentHedgeNotional) ? inputs.currentHedgeNotional : 0);

  if (nav <= 0) {
    return {
      action: cur > 0 ? "sell" : "hold",
      targetNotional: 0,
      deltaNotional: -cur,
      targetPctNav: 0,
      regime,
      reason: "no NAV — hedge off",
    };
  }

  // CAPE tilt: linear ramp from baseline (at floor) up to max (at cap).
  const capeVal = Number.isFinite(inputs.cape as number) ? (inputs.cape as number) : cfg.capeFloor;
  const span = Math.max(1e-6, cfg.capeCap - cfg.capeFloor);
  const t = clamp((capeVal - cfg.capeFloor) / span, 0, 1);
  const capeSizedPct = cfg.baselinePctNav + t * (cfg.maxPctNav - cfg.baselinePctNav);

  // Regime multiplier, then cap.
  const regimeMult = REGIME_MULT[regime];
  const rawPct = capeSizedPct * regimeMult;
  const targetPct = clamp(rawPct, 0, cfg.maxPctNav);
  const targetNotional = targetPct * nav;

  const delta = targetNotional - cur;
  const threshold = cfg.rebalanceThresholdPctNav * nav;
  if (Math.abs(delta) < threshold) {
    return {
      action: "hold",
      targetNotional,
      deltaNotional: 0,
      targetPctNav: targetPct,
      regime,
      reason: `within ${(cfg.rebalanceThresholdPctNav * 100).toFixed(2)}% NAV threshold`,
    };
  }

  return {
    action: delta > 0 ? "buy" : "sell",
    targetNotional,
    deltaNotional: delta,
    targetPctNav: targetPct,
    regime,
    reason: `cape=${capeVal.toFixed(1)} regime=${regime} mult=${regimeMult.toFixed(2)} → ${(targetPct * 100).toFixed(2)}% NAV`,
  };
}
