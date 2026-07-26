// Server-only helpers for the earnings_cache table.
//
// Read path is safe for any authenticated caller via RLS. Write path uses
// the service-role client because the cache is populated by background
// jobs, not by end users.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type EarningsRow = {
  symbol: string;
  next_earnings_date: string | null;
  confidence: string;
  source: string;
  fetched_at: string;
  expires_at: string;
};

export async function fetchEarningsDates(
  supabase: SupabaseClient<Database>,
  symbols: string[],
): Promise<Map<string, EarningsRow>> {
  const out = new Map<string, EarningsRow>();
  if (symbols.length === 0) return out;
  const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const { data, error } = await supabase
    .from("earnings_cache")
    .select("symbol, next_earnings_date, confidence, source, fetched_at, expires_at")
    .in("symbol", uniq);
  if (error) return out;
  for (const row of (data ?? []) as EarningsRow[]) {
    if (new Date(row.expires_at).getTime() < Date.now()) continue;
    out.set(row.symbol.toUpperCase(), row);
  }
  return out;
}

export async function upsertEarningsDate(
  supabase: SupabaseClient<Database>,
  row: {
    symbol: string;
    next_earnings_date: string | null;
    confidence?: string;
    source?: string;
    ttl_days?: number;
  },
): Promise<void> {
  const ttl = Math.max(1, row.ttl_days ?? 14);
  const expires = new Date(Date.now() + ttl * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from("earnings_cache" as never).upsert(
    {
      symbol: row.symbol.toUpperCase(),
      next_earnings_date: row.next_earnings_date,
      confidence: row.confidence ?? "estimated",
      source: row.source ?? "manual",
      fetched_at: new Date().toISOString(),
      expires_at: expires,
    } as never,
    { onConflict: "symbol" } as never,
  );
}
