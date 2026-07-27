// Phase 5 — Execution realism for the paper engine.
// Live AI tick previously assumed mid-price fills. We now:
//   - apply an ATR-derived half-spread + fixed slippage to every buy
//   - cap notional at 1% of 20-day average dollar volume (liquidity cap)
//   - respect a small min_trade_value so pennies aren't churned

export type ExecutionParams = {
  slippage_bps: number;    // per side
  commission_bps: number;  // per side
  spread_atr_frac: number; // half-spread = spread_atr_frac * ATR%
  adv_participation: number; // max fraction of 20d ADV$ per trade
  min_trade_value: number;
  /**
   * Minimum per-side commission in trade currency (e.g. Saxo's £3 UK / $1 US
   * / €3 EU floor). When set, effective per-side commission is
   * `max(commission_bps * notional, min_commission)`. Defaults to 0 for
   * back-compat with existing backtests.
   */
  min_commission?: number;
};

export const DEFAULT_EXECUTION: ExecutionParams = {
  slippage_bps: 8,
  commission_bps: 5,
  spread_atr_frac: 0.25,
  adv_participation: 0.01, // 1% of ADV
  min_trade_value: 25,
  min_commission: 0,
};

export type ExecutionOutcome = {
  fillPrice: number;
  effectiveSpend: number; // includes commission
  qty: number;
  costPaid: number;
  liquidityCappedSpend: number | null; // if trimmed
  belowMinTrade: boolean;
  notes: string[];
};

export function applyBuyExecution(args: {
  requestedSpend: number;
  price: number;
  atrPct: number | null;
  adv20d: number | null; // dollar-volume 20d average
  params?: Partial<ExecutionParams>;
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

  // Fill price: mid × (1 + half-spread + slippage)
  const halfSpread = args.atrPct && args.atrPct > 0 ? args.atrPct * p.spread_atr_frac : 0;
  const slip = p.slippage_bps / 10_000;
  const fillPrice = args.price * (1 + halfSpread + slip);
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
      notes: [...notes, minComm > 0 && spend <= minComm
        ? `blocked: notional ${spend.toFixed(0)} <= min commission ${minComm.toFixed(0)}`
        : `below min trade value ${p.min_trade_value}`],
    };
  }
  const costPaid = spend - qty * args.price;
  if (halfSpread > 0) notes.push(`spread ${(halfSpread * 10_000).toFixed(1)}bps`);
  notes.push(`slippage ${p.slippage_bps}bps, commission ${p.commission_bps}bps${minComm > 0 ? ` (min ${minComm})` : ""}`);

  return {
    fillPrice,
    effectiveSpend: spend,
    qty,
    costPaid,
    liquidityCappedSpend,
    belowMinTrade: false,
    notes,
  };
}

/**
 * Sell-side execution: apply symmetric slippage/spread/commission.
 * Returns net proceeds.
 */
export function applySellExecution(args: {
  qty: number;
  price: number;
  atrPct: number | null;
  params?: Partial<ExecutionParams>;
}): { fillPrice: number; proceedsNet: number; costPaid: number } {
  const p = { ...DEFAULT_EXECUTION, ...(args.params ?? {}) };
  const halfSpread = args.atrPct && args.atrPct > 0 ? args.atrPct * p.spread_atr_frac : 0;
  const slip = p.slippage_bps / 10_000;
  const fillPrice = args.price * (1 - halfSpread - slip);
  const gross = args.qty * fillPrice;
  const minComm = Math.max(0, p.min_commission ?? 0);
  const commission = Math.max(gross * (p.commission_bps / 10_000), minComm);
  const proceedsNet = Math.max(0, gross - commission);
  const costPaid = args.qty * args.price - proceedsNet;
  return { fillPrice, proceedsNet, costPaid };
}
