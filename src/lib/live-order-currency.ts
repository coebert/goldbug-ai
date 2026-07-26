// Pure helper for resolving the ISO-4217 currency stamped on live_orders rows.
// Extracted from live-executor.server.ts so the priority chain
//   caller hint > saxo_instrument_cache > portfolio base currency
// can be regression-tested without booting Supabase. Never returns a hardcoded
// fallback like "GBP" — the caller must supply a portfolio currency, which is
// itself always known from portfolios.currency.

export interface OrderCcyInput {
  symbol: string;
  instrument_ccy?: string | null;
}

export interface OrderCcyContext {
  /** Map of symbol -> currency as returned by saxo_instrument_cache. */
  cache?: Map<string, string | null | undefined>;
  /** Portfolio base currency; must itself be a valid ISO-4217 code. */
  portfolioCurrency: string;
}

const ISO_4217 = /^[A-Z]{3}$/;

export function normaliseCcy(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  return ISO_4217.test(up) ? up : null;
}

/**
 * Resolve the currency for a single order. Throws if no valid ISO-4217 code
 * can be produced — the DB CHECK constraint (`live_orders_instrument_ccy_iso4217`)
 * would reject the row anyway, so failing here surfaces the bug loudly at the
 * call site instead of as an opaque insert error.
 */
export function resolveOrderCurrency(
  order: OrderCcyInput,
  ctx: OrderCcyContext,
): string {
  const fromCaller = normaliseCcy(order.instrument_ccy);
  if (fromCaller) return fromCaller;
  const fromCache = normaliseCcy(ctx.cache?.get(order.symbol));
  if (fromCache) return fromCache;
  const fromPortfolio = normaliseCcy(ctx.portfolioCurrency);
  if (fromPortfolio) return fromPortfolio;
  throw new Error(
    `Unable to resolve instrument currency for ${order.symbol}: ` +
      `no caller hint, no cache row, and portfolioCurrency=${JSON.stringify(ctx.portfolioCurrency)} is not ISO-4217`,
  );
}

/** Batch form used by the executor. Mirrors the loop it replaces. */
export function resolveOrderCurrencies<T extends OrderCcyInput>(
  orders: T[],
  ctx: OrderCcyContext,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const o of orders) {
    if (out.has(o.symbol)) continue;
    out.set(o.symbol, resolveOrderCurrency(o, ctx));
  }
  return out;
}
