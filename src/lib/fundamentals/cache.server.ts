// Read-through cache + loader for published company financials.
//
// Financial statements change quarterly, so a 24h TTL is generous; the cache
// exists so an hourly tick does not re-fetch 20+ companies from the provider
// every hour. Reads are cheap and shared across portfolios.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLogger } from "@/lib/_server/log";
import type { Fundamentals, FundamentalsScore } from "./types";
import { scoreFundamentals } from "./score";
import { fetchFundamentals } from "./yahoo-fundamentals.server";

const log = createLogger("fundamentals");

const DEFAULT_TTL_HOURS = 24;
/** Cap concurrent provider calls so a large universe cannot stall the tick. */
const FETCH_CONCURRENCY = 4;

type CacheRow = {
  symbol: string;
  data: Fundamentals;
  expires_at: string;
};

async function readCache(symbols: string[]): Promise<Map<string, CacheRow>> {
  const out = new Map<string, CacheRow>();
  if (symbols.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from("fundamentals_cache" as never)
    .select("symbol, data, expires_at")
    .in("symbol", symbols);
  if (error) {
    log.warn("cache read failed", { error: error.message });
    return out;
  }
  for (const row of (data ?? []) as unknown as CacheRow[]) {
    out.set(row.symbol.toUpperCase(), row);
  }
  return out;
}

async function writeCache(rows: Fundamentals[], ttlHours: number): Promise<void> {
  if (rows.length === 0) return;
  const expires = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  const payload = rows.map((f) => ({
    symbol: f.symbol.toUpperCase(),
    data: f as unknown as Record<string, unknown>,
    currency: f.currency,
    financial_currency: f.financial_currency,
    next_earnings_date: f.next_earnings_date,
    source: f.source,
    fetched_at: f.fetched_at,
    expires_at: expires,
  }));
  const { error } = await supabaseAdmin
    .from("fundamentals_cache" as never)
    .upsert(payload as never, { onConflict: "symbol" } as never);
  if (error) log.warn("cache write failed", { error: error.message });
}

/** Run `worker` over `items` with bounded concurrency. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Published financials for every requested symbol, served from cache where
 * fresh and refetched where stale. Never throws: a provider outage degrades to
 * "no fundamentals for this symbol", which the scorer treats as unknown rather
 * than bad.
 */
export async function loadFundamentals(
  symbols: string[],
  opts?: { ttlHours?: number; staleOk?: boolean },
): Promise<Map<string, Fundamentals>> {
  const ttl = opts?.ttlHours ?? DEFAULT_TTL_HOURS;
  const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).filter(Boolean);
  const out = new Map<string, Fundamentals>();
  if (uniq.length === 0) return out;

  const cache = await readCache(uniq);
  const now = Date.now();
  const stale: string[] = [];

  for (const symbol of uniq) {
    const row = cache.get(symbol);
    if (row?.data) out.set(symbol, row.data);
    if (!row || Date.parse(row.expires_at) < now) stale.push(symbol);
  }

  if (stale.length === 0 || opts?.staleOk) return out;

  const fetched = await mapLimit(stale, FETCH_CONCURRENCY, (s) =>
    fetchFundamentals(s).catch(() => null),
  );
  const fresh = fetched.filter((f): f is Fundamentals => f != null);
  for (const f of fresh) out.set(f.symbol.toUpperCase(), f);
  await writeCache(fresh, ttl).catch(() => undefined);

  return out;
}

/** Convenience: load and score in one pass, keyed by symbol. */
export async function loadFundamentalsScores(
  symbols: string[],
  asOf: string,
  opts?: { ttlHours?: number; staleOk?: boolean },
): Promise<Map<string, { data: Fundamentals; score: FundamentalsScore }>> {
  const data = await loadFundamentals(symbols, opts);
  const out = new Map<string, { data: Fundamentals; score: FundamentalsScore }>();
  for (const [symbol, f] of data) {
    out.set(symbol, { data: f, score: scoreFundamentals(f, asOf, symbol) });
  }
  return out;
}
