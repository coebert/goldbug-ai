/**
 * Broker-sourced market data.
 *
 * Everything in the app used to price off Yahoo's free chart endpoint: a
 * delayed, adjusted, third-party tape that is *not* the tape our orders
 * actually execute against. That gap showed up twice —
 *   1. historical backtests replayed on Yahoo closes while live fills happened
 *      at Saxo prices, so the "backtest vs real" comparison measured feed
 *      differences as much as strategy differences;
 *   2. the live dashboard valued holdings off the same delayed tape while the
 *      broker was quoting something else.
 *
 * This module makes Saxo the primary source for both daily bars and live
 * quotes, with Yahoo kept only as a fallback for instruments Saxo cannot
 * resolve (indices, FX pseudo-tickers, retired lines).
 *
 * Server-only. Never import from a client component.
 */

import type { SaxoAdapter } from "./saxo.server";
import { resolvePortfolioBrokerLink } from "./portfolio-broker-link.server";

export type BrokerBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type BrokerQuote = {
  symbol: string;
  price: number;
  bid: number | null;
  ask: number | null;
  currency: string;
  at: string;
};

/**
 * Symbols Saxo will never resolve to a cash instrument: FX pseudo-pairs,
 * indices and futures. Skip the lookup entirely so we don't burn a broker
 * round-trip (and a "not found" log row) per call.
 */
export function isBrokerRoutable(symbol: string): boolean {
  const s = String(symbol ?? "").trim().toUpperCase();
  if (!s) return false;
  if (/[=^]/.test(s)) return false;
  if (/^[A-Z]{6}$/.test(s)) return false; // bare FX pair
  return true;
}

// Adapter reuse: instrument lookups and tick schemes are memoised per adapter
// instance, so one adapter per (portfolio, env) per Worker invocation keeps
// the broker call count flat even when a backtest walks hundreds of symbols.
const adapterCache = new Map<string, Promise<SaxoAdapter | null>>();

/** Symbols this Worker instance already proved Saxo cannot price. */
const unroutable = new Set<string>();

type PriceAccount = {
  portfolioId: string;
  userId: string;
  env: "sim" | "live";
  accountKey: string;
};

/**
 * The broker account whose feed prices the app: the real-money portfolio when
 * one exists, else the sim account. Falls back to `null` when no portfolio is
 * broker-linked, which is the signal to keep using the public tape.
 */
async function resolvePriceAccount(portfolioId?: string): Promise<PriceAccount | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let q = supabaseAdmin
    .from("portfolios")
    .select("id, user_id, mode, broker, broker_account_id")
    .in("mode", ["live_prod", "live_sim"]);
  if (portfolioId) q = q.eq("id", portfolioId);
  const { data } = await q;
  const rows = (data ?? []) as Array<{
    id: string; user_id: string | null; mode: string | null;
    broker: string | null; broker_account_id: string | null;
  }>;
  // Prefer the live account: its feed is the one our real fills print against.
  rows.sort((a, b) => (a.mode === "live_prod" ? 0 : 1) - (b.mode === "live_prod" ? 0 : 1));
  for (const row of rows) {
    if (!row.user_id) continue;
    const link = resolvePortfolioBrokerLink(row);
    if (!link.linked) continue;
    return {
      portfolioId: row.id,
      userId: row.user_id,
      env: row.mode === "live_prod" ? "live" : "sim",
      accountKey: link.accountKey,
    };
  }
  return null;
}

async function getPriceAdapter(portfolioId?: string): Promise<SaxoAdapter | null> {
  const key = portfolioId ?? "__default__";
  const cached = adapterCache.get(key);
  if (cached) return cached;
  const built = (async () => {
    try {
      const account = await resolvePriceAccount(portfolioId);
      if (!account) return null;
      const { buildSaxoAdapter } = await import("./saxo.server");
      return await buildSaxoAdapter({
        userId: account.userId,
        portfolioId: account.portfolioId,
        envOverride: account.env,
        accountKey: account.accountKey,
      });
    } catch (err) {
      console.warn("saxo-prices: no broker adapter available", err);
      return null;
    }
  })();
  adapterCache.set(key, built);
  return built;
}

/** The adapter the price feed uses, for callers that need broker streaming. */
export async function getBrokerPriceAdapter(portfolioId?: string): Promise<SaxoAdapter | null> {
  return getPriceAdapter(portfolioId);
}

/** Test/hot-reload seam: drop memoised adapters and negative caches. */

export function resetBrokerPriceCaches(): void {
  adapterCache.clear();
  unroutable.clear();
}

/**
 * Daily bars straight from the broker, ending on `to` (inclusive).
 * Returns `null` — never throws — when the broker cannot price the symbol, so
 * every caller can fall back to the public tape.
 */
export async function fetchBrokerDailyBars(
  symbol: string,
  opts: { count: number; to?: string; portfolioId?: string },
): Promise<BrokerBar[] | null> {
  if (!isBrokerRoutable(symbol) || unroutable.has(symbol)) return null;
  const adapter = await getPriceAdapter(opts.portfolioId);
  if (!adapter) return null;
  try {
    const bars = await adapter.fetchDailyBars(symbol, { count: opts.count, to: opts.to });
    if (bars.length === 0) return null;
    return bars;
  } catch (err) {
    // An instrument the broker cannot resolve stays unresolvable for this run.
    if (String(err).includes("instrument not found") || String(err).includes("pseudo-symbol")) {
      unroutable.add(symbol);
    } else {
      console.warn(`saxo-prices: bar fetch failed for ${symbol}`, err);
    }
    return null;
  }
}

/** Live broker quote for one symbol, or `null` when unavailable. */
export async function fetchBrokerQuote(
  symbol: string,
  opts?: { portfolioId?: string },
): Promise<BrokerQuote | null> {
  if (!isBrokerRoutable(symbol) || unroutable.has(symbol)) return null;
  const adapter = await getPriceAdapter(opts?.portfolioId);
  if (!adapter) return null;
  try {
    return await adapter.fetchQuote(symbol);
  } catch (err) {
    if (String(err).includes("instrument not found") || String(err).includes("pseudo-symbol")) {
      unroutable.add(symbol);
    } else {
      console.warn(`saxo-prices: quote failed for ${symbol}`, err);
    }
    return null;
  }
}

/** Live broker quotes for a basket, resolved sequentially to respect throttling. */
export async function fetchBrokerQuotes(
  symbols: string[],
  opts?: { portfolioId?: string },
): Promise<Record<string, BrokerQuote>> {
  const out: Record<string, BrokerQuote> = {};
  const unique = [...new Set(symbols.filter(Boolean))];
  for (const symbol of unique) {
    const quote = await fetchBrokerQuote(symbol, opts);
    if (quote) out[symbol] = quote;
  }
  return out;
}
