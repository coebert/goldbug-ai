// Intent-level ticket aggregation.
//
// Evidence (live_prod "My Portfolio", 25 Jul – 7 Aug 2026): MKS.L was bought
// nine separate times (4 on 29 Jul alone) for a £4.5k total position, and
// VMID.L five times for £521 — an average £104 ticket against a £3 Saxo
// commission floor plus 0.5% stamp duty. Each of those tickets paid the floor
// again. The engine was expressing ~8 real ideas with 40 commissionable
// orders.
//
// This module collapses a tick's orders down to one ticket per (symbol, side)
// and nets opposing intents in the same symbol, so the book pays the fixed
// cost once per idea instead of once per slice. It is pure: quantities and
// prices in, aggregated tickets out. Quantity-weighted average price is used
// so the downstream notional and cost estimates stay correct.

export type AggregatableOrder = {
  symbol: string;
  side: string;
  quantity: number;
  price: number;
};

export type AggregationNote = {
  symbol: string;
  side: "buy" | "sell";
  /** How many separate tickets were collapsed into one. */
  merged: number;
  /** True when opposing buy/sell intents in the same symbol were netted. */
  netted: boolean;
  quantity: number;
  notional: number;
};

export type AggregationResult<T extends AggregatableOrder> = {
  orders: T[];
  notes: AggregationNote[];
  /** Tickets removed by merging or netting — the commission floors saved. */
  ticketsSaved: number;
};

function normSide(side: string): "buy" | "sell" {
  return String(side).toLowerCase() === "sell" ? "sell" : "buy";
}

/**
 * Collapse same-symbol/same-side orders into a single ticket and net opposing
 * sides within the same symbol.
 *
 * The returned order objects are shallow clones of the *first* order seen for
 * that symbol+side, with `quantity` and `price` replaced by the aggregate and
 * the quantity-weighted average, so every other field the executor relies on
 * (instrument currency, decision metadata, ids) is preserved.
 *
 * Netting rule: when a tick contains both a buy and a sell in one symbol —
 * which is nearly always a signal-vs-exit disagreement, not a real round trip
 * — the smaller leg is cancelled against the larger. Trading both legs pays
 * two commissions and the spread twice to end up at the same net position.
 * If the two legs are equal the symbol drops out entirely.
 */
export function aggregateOrders<T extends AggregatableOrder>(
  orders: T[],
): AggregationResult<T> {
  type Bucket = { first: T; qty: number; notional: number; count: number };
  const buckets = new Map<string, Bucket>();
  const order: string[] = [];

  for (const o of orders) {
    const qty = Number(o.quantity);
    const price = Number(o.price);
    if (!(qty > 0) || !Number.isFinite(price)) continue;
    const side = normSide(o.side);
    const key = `${o.symbol}|${side}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.qty += qty;
      existing.notional += qty * price;
      existing.count += 1;
    } else {
      buckets.set(key, { first: o, qty, notional: qty * price, count: 1 });
      order.push(key);
    }
  }

  // Net opposing sides per symbol.
  const netted = new Set<string>();
  const symbols = new Set(order.map((k) => k.split("|")[0] as string));
  for (const symbol of symbols) {
    const buy = buckets.get(`${symbol}|buy`);
    const sell = buckets.get(`${symbol}|sell`);
    if (!buy || !sell) continue;
    const overlap = Math.min(buy.qty, sell.qty);
    if (!(overlap > 0)) continue;
    for (const [bucket, key] of [
      [buy, `${symbol}|buy`],
      [sell, `${symbol}|sell`],
    ] as const) {
      const avg = bucket.notional / bucket.qty;
      bucket.qty -= overlap;
      bucket.notional = bucket.qty * avg;
      netted.add(key);
      if (bucket.qty <= 0) buckets.delete(key);
    }
  }

  const out: T[] = [];
  const notes: AggregationNote[] = [];
  let ticketsSaved = 0;

  for (const key of order) {
    const bucket = buckets.get(key);
    const [, sideKey] = key.split("|");
    const side = sideKey === "sell" ? "sell" : "buy";
    if (!bucket) {
      // Fully netted away.
      ticketsSaved += 1;
      notes.push({
        symbol: key.split("|")[0] as string,
        side,
        merged: 0,
        netted: true,
        quantity: 0,
        notional: 0,
      });
      continue;
    }
    const avgPrice = bucket.notional / bucket.qty;
    out.push({ ...bucket.first, quantity: bucket.qty, price: avgPrice });
    ticketsSaved += bucket.count - 1;
    if (bucket.count > 1 || netted.has(key)) {
      notes.push({
        symbol: bucket.first.symbol,
        side,
        merged: bucket.count,
        netted: netted.has(key),
        quantity: bucket.qty,
        notional: bucket.notional,
      });
    }
  }

  return { orders: out, notes, ticketsSaved };
}
