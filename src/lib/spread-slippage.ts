// Bid-ask spread + slippage microstructure model.
//
// The Phase-5 execution realism previously modelled trading costs as a flat
// `ATR% * spread_atr_frac` half-spread plus a fixed per-side slippage in bps.
// That is coarse: it ignores per-venue typical spreads and, crucially, has
// NO dependence on order size vs available liquidity. In reality a £50k
// order in a £2m/day name pays far more than a £500 one — this is market
// impact, not commission.
//
// This module is I/O-free and adds two decomposable pieces the execution
// realism layer can call directly:
//
//   halfSpread = base_half_spread + vol_widening
//              base_half_spread = per-asset-class typical top-of-book spread /2
//              vol_widening    = coeff * ATR% (books widen in vol regimes)
//
//   slippage   = latency_bps + impact_bps + urgency_bps
//              impact_bps  = k * sigma_bps * sqrt(participation)      // sqrt-law
//              participation = orderNotional / adv20d
//              urgency_bps = 0 (passive) | ~half-spread (normal) | full-spread (aggressive)
//
// The sqrt-impact model is the standard Almgren/Kissell/BARRA form used
// across sell-side TCA. `impact_coeff` calibrates the magnitude; sensible
// defaults land a 1% ADV order at ~10-15bps for typical equities.

import type { AssetClass } from "./universe.server";

/** Urgency selects how aggressively the order crosses the book. */
export type OrderUrgency = "passive" | "normal" | "aggressive";

/** Per-asset-class typical top-of-book spread (round-trip, in bps). Used
 *  as a floor when we have no live L1 quote — deliberately conservative. */
export const BASE_SPREAD_BPS_BY_CLASS: Record<AssetClass, number> = {
  etf: 4,        // SPY-class ETFs quote inside 1bps; VUKE etc. ~6bps.
  stock: 10,     // AAPL/MSFT ~2bps; small-cap LSE names 20-40bps → 10 avg.
  crypto: 30,    // ETPs like BTCE.DE / BTCW.L quote ~20-40bps depending on venue.
  commodity: 12, // Physically-backed metals ETCs ~8-15bps.
  fx: 2,         // Major pairs 0.5-2bps at retail prime brokers.
};

/** Per-venue-currency multiplier on the base spread. LSE small tick sizes
 *  and Xetra fragmentation push spreads out relative to US listings. */
export const VENUE_SPREAD_MULT: Record<string, number> = {
  USD: 1.0,
  GBP: 1.3,
  EUR: 1.2,
  CHF: 1.3,
  JPY: 1.1,
  HKD: 1.4,
  AUD: 1.2,
  CAD: 1.1,
  DKK: 1.3,
  SEK: 1.3,
  NOK: 1.3,
};

export type SpreadSlippageInputs = {
  assetClass?: AssetClass | null;
  /** ISO 4217 trade currency; if omitted the base spread is unscaled. */
  currency?: string | null;
  /** 14d ATR expressed as a fraction of price (e.g. 0.018 = 1.8%). */
  atrPct?: number | null;
  /** Notional to trade in the same currency as `adv20d`. */
  notional: number;
  /** 20-day average traded value in trade currency (same as notional). */
  adv20d?: number | null;
  urgency?: OrderUrgency;
  /** Optional tuning overrides — kept minimal so calibration can adjust
   *  the model without touching call sites. */
  overrides?: Partial<SpreadSlippageTuning>;
};

export type SpreadSlippageTuning = {
  /** Additional half-spread widening per unit of ATR%. `atrPct=0.02` with
   *  coeff=200 → 400bps × 0.02 = 4bps extra half-spread. */
  vol_widening_coeff_bps: number;
  /** Fixed per-side latency toll (venue queue-position + our tick latency). */
  latency_slippage_bps: number;
  /** Market-impact constant on the sqrt-participation model.
   *  impact_bps = k * sigma_bps * sqrt(participation). */
  impact_coeff: number;
  /** Cap on the modelled impact contribution so pathological ADV values
   *  cannot dominate outputs. */
  max_impact_bps: number;
  /** Cap on the modelled half-spread (base + widening). */
  max_half_spread_bps: number;
  /** Additional bps paid per side when urgency = "aggressive". */
  aggressive_bps: number;
  /** Rebate/save when urgency = "passive" (post-only style). */
  passive_bps: number;
};

export const DEFAULT_TUNING: SpreadSlippageTuning = {
  vol_widening_coeff_bps: 150,
  latency_slippage_bps: 3,
  impact_coeff: 12,
  max_impact_bps: 120,
  max_half_spread_bps: 150,
  aggressive_bps: 4,
  passive_bps: -1,
};

export type SpreadSlippageBreakdown = {
  /** Effective per-side half-spread crossed (bps of price). */
  halfSpreadBps: number;
  /** Fixed latency component (bps). */
  latencyBps: number;
  /** Size-dependent market impact (bps). */
  impactBps: number;
  /** Urgency adjustment (bps). Can be negative for passive orders. */
  urgencyBps: number;
  /** Total per-side execution cost in bps of mid price. */
  totalBps: number;
  /** Participation rate applied to the sqrt-impact model. */
  participation: number;
  /** Human-readable notes for logs and TCA panels. */
  notes: string[];
};

function baseHalfSpreadBps(
  assetClass: AssetClass | null | undefined,
  currency: string | null | undefined,
): number {
  const base = assetClass ? BASE_SPREAD_BPS_BY_CLASS[assetClass] ?? 10 : 10;
  const mult = currency ? VENUE_SPREAD_MULT[currency.toUpperCase()] ?? 1 : 1;
  return (base * mult) / 2;
}

/**
 * Estimate the per-side execution cost (bps of mid) for an order.
 *
 * Callers typically want `totalBps` and then apply it symmetrically to buy
 * and sell fills (buy at mid × (1 + totalBps/10000), sell at mid × (1 −
 * totalBps/10000)). The breakdown lets TCA panels attribute costs.
 */
export function estimateSpreadSlippage(input: SpreadSlippageInputs): SpreadSlippageBreakdown {
  const tuning = { ...DEFAULT_TUNING, ...(input.overrides ?? {}) };
  const notes: string[] = [];

  // 1) Half-spread: per-venue base + ATR-driven widening.
  const baseHalf = baseHalfSpreadBps(input.assetClass, input.currency);
  const atrPct = Math.max(0, Number(input.atrPct) || 0);
  const widening = atrPct * tuning.vol_widening_coeff_bps;
  const halfSpreadBps = Math.min(tuning.max_half_spread_bps, baseHalf + widening);
  notes.push(
    `spread base ${baseHalf.toFixed(1)}bps + vol ${widening.toFixed(1)}bps`
    + ` = ${halfSpreadBps.toFixed(1)}bps half`,
  );

  // 2) Latency slippage — fixed per side.
  const latencyBps = Math.max(0, tuning.latency_slippage_bps);

  // 3) Market impact — sqrt(participation) model, scaled by realised vol.
  const notional = Math.max(0, Number(input.notional) || 0);
  const adv = Math.max(0, Number(input.adv20d) || 0);
  const participation = adv > 0 ? notional / adv : 0;
  // Convert ATR% to a bps sigma proxy. If atrPct is missing fall back to a
  // conservative 100bps daily sigma — enough to keep large orders honest.
  const sigmaBps = atrPct > 0 ? atrPct * 10_000 : 100;
  const rawImpact = tuning.impact_coeff * sigmaBps * Math.sqrt(participation) / 100;
  const impactBps = Math.min(tuning.max_impact_bps, Math.max(0, rawImpact));
  if (participation > 0) {
    notes.push(
      `impact ${impactBps.toFixed(1)}bps @ ${(participation * 100).toFixed(2)}%`
      + ` participation (sigma ${sigmaBps.toFixed(0)}bps)`,
    );
  } else {
    notes.push(`impact 0bps (no ADV reference)`);
  }

  // 4) Urgency adjustment.
  const urgency: OrderUrgency = input.urgency ?? "normal";
  const urgencyBps = urgency === "aggressive"
    ? tuning.aggressive_bps
    : urgency === "passive"
      ? tuning.passive_bps
      : 0;
  if (urgencyBps !== 0) notes.push(`urgency ${urgency} ${urgencyBps > 0 ? "+" : ""}${urgencyBps}bps`);

  const totalBps = Math.max(0, halfSpreadBps + latencyBps + impactBps + urgencyBps);

  return {
    halfSpreadBps,
    latencyBps,
    impactBps,
    urgencyBps,
    totalBps,
    participation,
    notes,
  };
}

/**
 * Convenience — the max notional (in trade currency) at which the modelled
 * per-side impact stays below `maxImpactBps`. Useful for pre-sizing (e.g.
 * capping BUY size before it eats the expected edge).
 *
 * Solves impact_bps <= cap for `notional`:
 *   k * sigma * sqrt(notional/adv) / 100 <= cap
 *   notional <= adv * (100*cap / (k*sigma))^2
 */
export function maxNotionalForImpactCap(args: {
  adv20d: number;
  atrPct: number;
  maxImpactBps: number;
  overrides?: Partial<SpreadSlippageTuning>;
}): number {
  const t = { ...DEFAULT_TUNING, ...(args.overrides ?? {}) };
  const sigmaBps = args.atrPct > 0 ? args.atrPct * 10_000 : 100;
  if (t.impact_coeff <= 0 || sigmaBps <= 0 || args.adv20d <= 0) return Number.POSITIVE_INFINITY;
  const ratio = (100 * args.maxImpactBps) / (t.impact_coeff * sigmaBps);
  return Math.max(0, args.adv20d * ratio * ratio);
}
