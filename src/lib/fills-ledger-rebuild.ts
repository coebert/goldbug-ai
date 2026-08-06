// Pure helpers for rebuilding a portfolio ledger from broker fills.
//
// Two data defects made "Balanced risk sim" show no trading activity at all
// even though it had 13 recorded broker fills:
//
//   1. Fills promoted by the order reconciler frequently carry
//      `fill_price = 0` (the broker payload had no average price yet). A
//      trade row priced at 0 is worthless, so the ledger looked empty.
//   2. Prices that WERE recorded came back in raw exchange units — GBX for
//      LSE listings — so a 446-share SGLN.L position priced at 5872 implied
//      a £2.6m notional instead of £26k.
//
// Both are fixed here: resolve a missing price from cached daily closes, then
// fold every price through the same GBX→GBP normalisation the sizing path
// uses.

import { normalizeMarketPriceForTrading } from "./market-price-units";

export type FillLite = {
  id: string;
  symbol: string;
  side: string | null;
  quantity: number | string | null;
  fill_price: number | string | null;
  filled_at: string | null;
};

/** Cached daily closes: symbol (as stored) → sorted [date, close] pairs. */
export type CloseLookup = Map<string, Array<{ date: string; close: number }>>;

/** Latest cached close on or before `date`, in raw exchange units. */
export function closeOnOrBefore(
  closes: CloseLookup,
  symbol: string,
  date: string,
): number | null {
  const series = closes.get(symbol) ?? closes.get(symbol.toUpperCase()) ?? [];
  let best: number | null = null;
  for (const row of series) {
    if (row.date <= date && Number.isFinite(row.close) && row.close > 0) best = row.close;
  }
  return best;
}

/**
 * Price a fill in portfolio base units. Falls back to the cached close for the
 * fill date when the broker gave us no price. Returns 0 when nothing is known,
 * so callers can drop the row rather than write a bogus notional.
 *
 * `fill_price` is stored in the instrument's settlement currency — both write
 * paths now run through `resolveFillRecord`, and the fill-unit backfill has
 * re-normalised the history. Folding it again here would divide correct
 * pounds by 100, so only the raw `price_cache` fallback is normalised.
 */
export function resolveFillPrice(fill: FillLite, closes: CloseLookup): number {
  const raw = Number(fill.fill_price ?? 0);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const day = (fill.filled_at ?? "").slice(0, 10);
  const close = closeOnOrBefore(closes, fill.symbol, day) ?? 0;
  if (!(close > 0)) return 0;
  return normalizeMarketPriceForTrading(fill.symbol, close);
}


export type LedgerPosition = { symbol: string; quantity: number; avgCost: number };

export type RebuiltLedger = {
  positions: LedgerPosition[];
  /** Net cash effect of every fill: negative for net buying. */
  cashDelta: number;
};

/**
 * Replay priced fills into positions + a cash delta. Average cost follows the
 * standard weighted-average convention: buys re-average, sells reduce quantity
 * and leave avg cost untouched. Quantities that would go negative are clamped
 * to zero (a sell we never saw the matching buy for).
 */
export function rebuildLedgerFromFills(
  fills: Array<FillLite & { price: number }>,
): RebuiltLedger {
  const bySymbol = new Map<string, LedgerPosition>();
  let cashDelta = 0;

  const ordered = [...fills].sort((a, b) =>
    String(a.filled_at ?? "").localeCompare(String(b.filled_at ?? "")),
  );

  for (const f of ordered) {
    const qty = Number(f.quantity ?? 0);
    const price = Number(f.price ?? 0);
    if (!(qty > 0) || !(price > 0)) continue;
    const side = String(f.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";
    const pos = bySymbol.get(f.symbol) ?? { symbol: f.symbol, quantity: 0, avgCost: 0 };

    if (side === "buy") {
      const cost = pos.quantity * pos.avgCost + qty * price;
      pos.quantity += qty;
      pos.avgCost = pos.quantity > 0 ? cost / pos.quantity : 0;
      cashDelta -= qty * price;
    } else {
      const sold = Math.min(qty, pos.quantity);
      pos.quantity = Math.max(0, pos.quantity - qty);
      if (pos.quantity === 0) pos.avgCost = 0;
      cashDelta += sold * price;
    }
    bySymbol.set(f.symbol, pos);
  }

  return {
    positions: [...bySymbol.values()].filter((p) => p.quantity > 0),
    cashDelta,
  };
}
