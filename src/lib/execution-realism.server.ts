// Phase 5 — Execution realism for the paper engine.
// Live AI tick previously assumed mid-price fills. We now:
//   - apply a proper per-venue bid-ask spread + size-dependent slippage
//     (see `./spread-slippage`) that accounts for market impact, latency,
//     and urgency, not just a flat ATR fraction
//   - cap notional at 1% of 20-day average dollar volume (liquidity cap)
//   - respect a small min_trade_value so pennies aren't churned
//   - honour Saxo's per-venue minimum commission (see `./saxo-fees`)

import {
  estimateSpreadSlippage,
  type OrderUrgency,
  type SpreadSlippageBreakdown,
  type SpreadSlippageTuning,
} from "./spread-slippage";
import type { AssetClass } from "./universe.server";

export type ExecutionParams = {
  slippage_bps: number;    // per side — legacy fixed slippage floor
  commission_bps: number;  // per side
  spread_atr_frac: number; // legacy half-spread = spread_atr_frac * ATR%
  adv_participation: number; // max fraction of 20d ADV$ per trade
  min_trade_value: number;
  /**
   * Minimum per-side commission in trade currency (e.g. Saxo's £3 UK / $1 US
   * / €3 EU floor). When set, effective per-side commission is
   * `max(commission_bps * notional, min_commission)`. Defaults to 0 for
   * back-compat with existing backtests.
   */
  min_commission?: number;
  /**
   * When true (default), use the microstructure spread+slippage model in
   * `./spread-slippage`. Legacy backtests that need the flat ATR-fraction
   * path can set this to false to freeze pre-microstructure behaviour.
   */
  use_microstructure_model?: boolean;
  /** Optional overrides forwarded to the microstructure model. */
  microstructure?: Partial<SpreadSlippageTuning>;
};

export const DEFAULT_EXECUTION: ExecutionParams = {
  slippage_bps: 8,
  commission_bps: 5,
  spread_atr_frac: 0.25,
  adv_participation: 0.01, // 1% of ADV
  min_trade_value: 25,
  min_commission: 0,
  use_microstructure_model: true,
};

export type ExecutionOutcome = {
  fillPrice: number;
  effectiveSpend: number; // includes commission
  qty: number;
  costPaid: number;
  liquidityCappedSpend: number | null; // if trimmed
  belowMinTrade: boolean;
  notes: string[];
  /** Present when the microstructure model was used. Lets TCA panels
   *  attribute the fill price move to spread / impact / latency / urgency. */
  spreadSlippage?: SpreadSlippageBreakdown;
};

/**
 * Compute the effective per-side cost (bps of mid) using either the
 * microstructure model or the legacy ATR-fraction path.
 */
function computePerSideCostBps(args: {
  params: ExecutionParams;
  notional: number;
  price: number;
  atrPct: number | null;
  adv20d: number | null;
  assetClass?: AssetClass | null;
  currency?: string | null;
  urgency?: OrderUrgency;
}): { totalBps: number; breakdown?: SpreadSlippageBreakdown } {
  const useModel = args.params.use_microstructure_model !== false;
  if (useModel) {
    const b = estimateSpreadSlippage({
      assetClass: args.assetClass ?? null,
      currency: args.currency ?? null,
      atrPct: args.atrPct,
      notional: args.notional,
      adv20d: args.adv20d,
      urgency: args.urgency,
      overrides: args.params.microstructure,
    });
    // The microstructure model can be tuned lower than the operator's fixed
    // slippage floor — respect the floor as a lower bound on total cost.
    const floor = Math.max(0, args.params.slippage_bps);
    const total = Math.max(floor, b.totalBps);
    return { totalBps: total, breakdown: b };
  }
  const halfSpreadBps =
    args.atrPct && args.atrPct > 0
      ? args.atrPct * 10_000 * args.params.spread_atr_frac
      : 0;
  return { totalBps: halfSpreadBps + Math.max(0, args.params.slippage_bps) };
}

export function applyBuyExecution(args: {
  requestedSpend: number;
  price: number;
  atrPct: number | null;
  adv20d: number | null; // dollar-volume 20d average
  params?: Partial<ExecutionParams>;
  assetClass?: AssetClass | null;
  currency?: string | null;
  urgency?: OrderUrgency;
}): ExecutionOutcome {
  const p = { ...DEFAULT_EXECUTION, ...(args.params ?? {}) };
  const notes: string[] = [];

  // Liquidity cap
  let spend = args.requestedSpend;
  let liquidityCappedSpend: number | null = null;
  if (args.adv20d && args.adv20d > 0) {
    const maxNotional = args.adv20d * p.adv_participation;
    if (spend > maxNotional) {
      liquidityCappedSpend = maxNotional;
      spend = maxNotional;
      notes.push(`liquidity: capped at 1% of ADV ($${maxNotional.toFixed(0)})`);
    }
  }

  if (spend < p.min_trade_value) {
    return {
      fillPrice: args.price,
      effectiveSpend: 0,
      qty: 0,
      costPaid: 0,
      liquidityCappedSpend,
      belowMinTrade: true,
      notes: [...notes, `below min trade value $${p.min_trade_value}`],
    };
  }

  const cost = computePerSideCostBps({
    params: p,
    notional: spend,
    price: args.price,
    atrPct: args.atrPct,
    adv20d: args.adv20d,
    assetClass: args.assetClass,
    currency: args.currency,
    urgency: args.urgency,
  });

  // Fill price: mid × (1 + per-side cost). Buys pay the offer.
  const fillPrice = args.price * (1 + cost.totalBps / 10_000);
  const commissionRate = p.commission_bps / 10_000;
  const minComm = Math.max(0, p.min_commission ?? 0);
  // Try bps-only sizing first: spend = qty*fillPrice*(1 + commRate).
  let qty = spend / (fillPrice * (1 + commissionRate));
  let commission = qty * fillPrice * commissionRate;
  if (commission < minComm) {
    // Min-commission floor dominates: spend = qty*fillPrice + minComm.
    commission = minComm;
    qty = Math.max(0, (spend - minComm) / fillPrice);
  }
  if (qty <= 0 || qty * fillPrice + commission < p.min_trade_value) {
    return {
      fillPrice: args.price,
      effectiveSpend: 0,
      qty: 0,
      costPaid: 0,
      liquidityCappedSpend,
      belowMinTrade: true,
      notes: [
        ...notes,
        minComm > 0 && spend <= minComm
          ? `blocked: notional ${spend.toFixed(0)} <= min commission ${minComm.toFixed(0)}`
          : `below min trade value ${p.min_trade_value}`,
      ],
      spreadSlippage: cost.breakdown,
    };
  }
  const costPaid = spend - qty * args.price;
  if (cost.breakdown) notes.push(...cost.breakdown.notes);
  else notes.push(`slippage ${p.slippage_bps}bps (legacy)`);
  notes.push(`commission ${p.commission_bps}bps${minComm > 0 ? ` (min ${minComm})` : ""}`);

  return {
    fillPrice,
    effectiveSpend: spend,
    qty,
    costPaid,
    liquidityCappedSpend,
    belowMinTrade: false,
    notes,
    spreadSlippage: cost.breakdown,
  };
}

/**
 * Sell-side execution: apply symmetric spread/slippage/commission.
 * Returns net proceeds.
 */
export function applySellExecution(args: {
  qty: number;
  price: number;
  atrPct: number | null;
  adv20d?: number | null;
  params?: Partial<ExecutionParams>;
  assetClass?: AssetClass | null;
  currency?: string | null;
  urgency?: OrderUrgency;
}): {
  fillPrice: number;
  proceedsNet: number;
  costPaid: number;
  spreadSlippage?: SpreadSlippageBreakdown;
} {
  const p = { ...DEFAULT_EXECUTION, ...(args.params ?? {}) };
  const notional = args.qty * args.price;
  const cost = computePerSideCostBps({
    params: p,
    notional,
    price: args.price,
    atrPct: args.atrPct,
    adv20d: args.adv20d ?? null,
    assetClass: args.assetClass,
    currency: args.currency,
    urgency: args.urgency,
  });
  // Sells hit the bid: mid × (1 − per-side cost).
  const fillPrice = args.price * (1 - cost.totalBps / 10_000);
  const gross = args.qty * fillPrice;
  const minComm = Math.max(0, p.min_commission ?? 0);
  const commission = Math.max(gross * (p.commission_bps / 10_000), minComm);
  const proceedsNet = Math.max(0, gross - commission);
  const costPaid = args.qty * args.price - proceedsNet;
  return { fillPrice, proceedsNet, costPaid, spreadSlippage: cost.breakdown };
}
