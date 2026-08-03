// Price-map helpers for the trading engine (extracted verbatim).
import { getPriceOn } from "../market-data.server";
import { normalizeMarketPriceForTrading, holdingAvgCostBase } from "../market-price-units";
import { priceSymbolVariants, resolvePriceSymbol } from "../price-symbol";

// Resolve a live GBP-normalized price for a held symbol, tolerant of the
// symbol casing mismatch between `holdings.symbol` (often lowercase, e.g.
// "HSBA:xlon") and `priceMap` keys (uppercase). Falls back to the stored
// avg_cost with GBX→GBP normalization so LSE common stocks don't inflate the
// class-exposure buckets by 100× when the priceMap lookup misses.
// Price lookup by symbol alone (no holding row), tolerant of broker-native
// spellings. Returns null rather than guessing so callers can distinguish
// "no quote" from "quote is zero".
export function holdingPriceBySymbol(priceMap: Map<string, number>, symbol: string): number | null {
  for (const key of priceSymbolVariants(symbol)) {
    const v = priceMap.get(key) ?? priceMap.get(key.toLowerCase());
    if (v != null && Number.isFinite(v) && v > 0) return v;
  }
  const v = priceMap.get(symbol);
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}


export function holdingLivePrice(
  priceMap: Map<string, number>,
  h: { symbol: string; avg_cost: number | string; asset_class?: string | null },
): number {
  for (const key of priceSymbolVariants(h.symbol)) {
    const live = priceMap.get(key) ?? priceMap.get(key.toLowerCase());
    if (live != null && Number.isFinite(live)) return live;
  }
  const live = priceMap.get(h.symbol);
  if (live != null && Number.isFinite(live)) return live;
  return holdingAvgCostBase(h.symbol, h.avg_cost);
}

export async function currentPrices(symbols: string[], asOf: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    symbols.map(async (s) => {
      // Broker-native spellings ("MKS:xlon") are not Yahoo symbols: fetching
      // them 404s every tick and leaves the holding unpriced, which silently
      // falls back to cost basis. Resolve to the canonical price key first,
      // then publish the quote under every variant so lookups by either
      // spelling hit.
      const canonical = resolvePriceSymbol(s);
      const p = (await getPriceOn(canonical, asOf)) ?? (canonical === s ? null : await getPriceOn(s, asOf));
      if (p != null) {
        const norm = normalizeMarketPriceForTrading(canonical, p);
        for (const key of new Set([s, canonical, ...priceSymbolVariants(s)])) {
          out.set(key, norm);
          out.set(key.toUpperCase(), norm);
          out.set(key.toLowerCase(), norm);
        }
      }
    }),
  );
  return out;
}
