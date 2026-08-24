// Pure valuation of broker positions in the account's base currency.
//
// Saxo reports LSE instruments in pence (GBX) while the account currency is
// GBP. Summing raw quotes therefore inflates every `:xlon` position by 100x.
// This helper folds each quote to the base unit first and is used as the
// fallback whenever Saxo's authoritative account TotalValue is unavailable.

import { normalizeLseDisplayPriceToBase } from "./market-price-units";
import { holdingNativeValue } from "./fx-leg-value";

export type BrokerPositionValueInput = {
  symbol: string;
  quantity: number;
  marketPrice?: number | null;
  avgPrice?: number | null;
  assetClass?: string | null;
};

export function valueBrokerPositions(
  positions: BrokerPositionValueInput[],
): number {
  return positions.reduce((sum, p) => {
    const raw = Number(p.marketPrice) || Number(p.avgPrice) || 0;
    const qty = Number(p.quantity);
    if (!Number.isFinite(raw) || !Number.isFinite(qty)) return sum;
    const px = normalizeLseDisplayPriceToBase(p.symbol, raw, p.assetClass ?? null);
    // FX spot legs are P&L-only; their notional lives in the cash balance.
    return (
      sum +
      holdingNativeValue({
        assetClass: p.assetClass,
        quantity: qty,
        price: px,
        avgCost: normalizeLseDisplayPriceToBase(p.symbol, Number(p.avgPrice), p.assetClass ?? null),
      })
    );
  }, 0);
}

