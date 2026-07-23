// Rebalance-band trimming: if a position drifts above (target + band) of the
// portfolio, generate a synthetic SELL to trim it back to target. Winners get
// harvested instead of running unbounded.

export type RebalanceCandidate = {
  symbol: string;
  currentValue: number;
  currentPct: number;
  targetPct: number;
  overweightBy: number; // in portfolio-value units
  qtyToTrim: number;
  price: number;
};

export function computeRebalanceTrims(args: {
  totalValue: number;
  holdings: Array<{ symbol: string; quantity: number }>;
  priceMap: Map<string, number>;
  targetPerSymbolPct: number; // effective per-symbol cap acts as target
  bandPct?: number; // additional band above target before we trim
}): RebalanceCandidate[] {
  const band = args.bandPct ?? 0.25; // 25% above target triggers trim
  const trigger = args.targetPerSymbolPct * (1 + band);
  const out: RebalanceCandidate[] = [];
  if (args.totalValue <= 0) return out;
  for (const h of args.holdings) {
    const qty = Number(h.quantity);
    const price = args.priceMap.get(h.symbol);
    if (!price || !(qty > 0)) continue;
    const val = qty * price;
    const pct = val / args.totalValue;
    if (pct <= trigger) continue;
    const targetVal = args.totalValue * args.targetPerSymbolPct;
    const overweightBy = val - targetVal;
    const qtyToTrim = Math.floor(overweightBy / price * 100) / 100;
    if (qtyToTrim <= 0) continue;
    out.push({
      symbol: h.symbol,
      currentValue: val,
      currentPct: pct,
      targetPct: args.targetPerSymbolPct,
      overweightBy,
      qtyToTrim,
      price,
    });
  }
  return out;
}
