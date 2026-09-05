// Real-time quote overlay for the trading engine.
//
// `currentPrices()` reads the DAILY tape (`price_cache`), so every price the
// AI saw was the previous close — the same frozen number our own trades were
// booked at. Intraday the book, the candidate prices and the sizing maths all
// drifted away from what the market was actually quoting.
//
// This module re-prices the engine's price map from the live feed (broker tape
// first for routable instruments, real-time public feed for everything else)
// before valuation, sizing and the AI prompt run. It never throws: a dead feed
// leaves the daily closes exactly as they were.
//
// Server-only.

import { fetchLiveQuotes } from "@/lib/live-quotes.server";
import { isUsableQuote } from "@/lib/live-quotes";
import { normalizeMarketPriceForTrading } from "@/lib/market-price-units";
import { priceSymbolVariants, resolvePriceSymbol } from "@/lib/price-symbol";

export type LiveOverlayResult = {
  /** Symbols whose price was replaced by a live tick. */
  applied: string[];
  /** Symbols we asked the feed for. */
  requested: number;
  /** How many ticks came off the broker's own tape. */
  fromBroker: number;
  /** Newest tick timestamp across the basket. */
  asOf: string | null;
  /** Biggest move (in %) between the daily close and the live tick. */
  maxMovePct: number | null;
  /** Preformatted prompt block, or null when nothing was live. */
  block: string | null;
};

const EMPTY: LiveOverlayResult = {
  applied: [],
  requested: 0,
  fromBroker: 0,
  asOf: null,
  maxMovePct: null,
  block: null,
};

function setAllVariants(priceMap: Map<string, number>, symbol: string, price: number) {
  const canonical = resolvePriceSymbol(symbol);
  for (const key of new Set([symbol, canonical, ...priceSymbolVariants(symbol)])) {
    priceMap.set(key, price);
    priceMap.set(key.toUpperCase(), price);
    priceMap.set(key.toLowerCase(), price);
  }
}

function readExisting(priceMap: Map<string, number>, symbol: string): number | null {
  for (const key of priceSymbolVariants(symbol)) {
    const v = priceMap.get(key) ?? priceMap.get(key.toLowerCase());
    if (v != null && Number.isFinite(v) && v > 0) return v;
  }
  const v = priceMap.get(symbol);
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Overwrite the engine's price map with real-time quotes, in place.
 *
 * Units follow the same convention as `price_cache` (LSE lines arrive in
 * pence), so every tick goes through `normalizeMarketPriceForTrading` exactly
 * like a daily close does.
 */
export async function applyLiveQuotesToPriceMap(args: {
  priceMap: Map<string, number>;
  symbols: string[];
  /** Prefer the broker tape for these (typically holdings + candidates). */
  preferBrokerFor?: string[];
  portfolioId?: string;
  /** Historical replays must stay on the tape of the day being replayed. */
  skip?: boolean;
}): Promise<LiveOverlayResult> {
  if (args.skip) return EMPTY;
  const symbols = [...new Set(args.symbols.map((s) => String(s ?? "").trim()).filter(Boolean))];
  if (symbols.length === 0) return EMPTY;

  let result;
  try {
    result = await fetchLiveQuotes(symbols, {
      preferBrokerFor: args.preferBrokerFor ?? symbols,
      portfolioId: args.portfolioId,
    });
  } catch (err) {
    console.warn("[trading-engine] live quote overlay unavailable", err);
    return EMPTY;
  }

  const applied: string[] = [];
  const moves: Array<{ symbol: string; pct: number }> = [];

  for (const [symbol, quote] of Object.entries(result.quotes)) {
    if (!isUsableQuote(quote)) continue;
    const canonical = resolvePriceSymbol(symbol);
    const live = normalizeMarketPriceForTrading(canonical, quote.price);
    if (!Number.isFinite(live) || live <= 0) continue;
    const prior = readExisting(args.priceMap, symbol);
    // A tick that disagrees with the last close by >35% is far more likely a
    // unit or symbol-mapping error than a real move — keep the close.
    if (prior != null) {
      const pct = ((live - prior) / prior) * 100;
      if (Math.abs(pct) > 35) continue;
      moves.push({ symbol, pct });
    }
    setAllVariants(args.priceMap, symbol, live);
    applied.push(symbol);
  }

  if (applied.length === 0) return { ...EMPTY, requested: symbols.length };

  moves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const top = moves.slice(0, 8);
  const maxMovePct = top[0]?.pct ?? null;

  const block = [
    `LIVE MARKET PRICES (real-time, not last close):`,
    `- ${applied.length} of ${symbols.length} instruments re-priced from the live tape${
      result.fromBroker > 0 ? ` (${result.fromBroker} straight off the broker's own tape)` : ""
    }, newest tick ${result.asOf ?? "unknown"}.`,
    `- Every price, holding value and cash figure below is marked to these live quotes, NOT to the prices in the trade history.`,
    top.length > 0
      ? `- Biggest moves since the last close: ${top
          .map((m) => `${m.symbol} ${m.pct >= 0 ? "+" : ""}${m.pct.toFixed(2)}%`)
          .join(", ")}.`
      : null,
    `- Instruments with no live tick still show their last daily close; treat those levels as stale and size them more conservatively.`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    applied,
    requested: symbols.length,
    fromBroker: result.fromBroker,
    asOf: result.asOf,
    maxMovePct,
    block,
  };
}
