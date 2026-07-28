// Pure builder for holding sparkline series. Extracted from
// `getHoldingsHistory` so window/baseline invariants can be unit tested
// without a database round-trip. The server function is a thin wrapper that
// resolves rows from Supabase and delegates to this function.

import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";

export type HoldingInput = {
  symbol: string;
  quantity: number | string;
  avg_cost: number | string;
  opened_at?: string | null;
  asset_class?: string | null;
};

export type PricePoint = { date: string; close: number };

export type BuiltHoldingSeries = {
  symbol: string;
  opened_at: string | null;
  avg_cost: number;
  quantity: number;
  closes: number[];
  currentPrice: number | null;
  pctChangeSincePurchase: number | null;
  valueChangeSincePurchase: number | null;
  points: number;
};

/**
 * Build one holding's series given its cached daily closes. `closes` in the
 * output are ALWAYS anchored at avg_cost as element 0 (when avg > 0) and
 * only include prices on/after `opened_at`, so the sparkline window and
 * baseline exactly match the "% since purchase" tile.
 */
export function buildHoldingSeries(
  h: HoldingInput,
  cachedCloses: PricePoint[],
): BuiltHoldingSeries {
  const assetClass = h.asset_class ?? null;
  const avg = normalizeLseDisplayPriceToBase(h.symbol, Number(h.avg_cost), assetClass);
  const openedAt = h.opened_at ?? null;
  const openedDate = openedAt ? openedAt.slice(0, 10) : null;

  const postPurchase = openedDate
    ? cachedCloses.filter((p) => p.date >= openedDate)
    : cachedCloses.slice();

  const postCloses = postPurchase.map((p) =>
    normalizeLseDisplayPriceToBase(h.symbol, Number(p.close), assetClass),
  );

  const closes = avg > 0 ? [avg, ...postCloses] : postCloses;
  const currentPrice = postCloses.length > 0
    ? postCloses[postCloses.length - 1]
    : (closes.length > 0 ? closes[closes.length - 1] : null);
  const pct = currentPrice != null && avg > 0 ? (currentPrice - avg) / avg : null;
  const valueChange = currentPrice != null ? (currentPrice - avg) * Number(h.quantity) : null;

  return {
    symbol: h.symbol,
    opened_at: openedAt,
    avg_cost: avg,
    quantity: Number(h.quantity),
    closes,
    currentPrice,
    pctChangeSincePurchase: pct,
    valueChangeSincePurchase: valueChange,
    points: closes.length,
  };
}
