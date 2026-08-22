// Hourly per-symbol price history.
//
// `price_cache` is keyed by DATE, so every holding sparkline collapses to one
// point per trading day and all intraday movement disappears. Whenever the
// broker sync reads live positions it already knows each instrument's current
// market price, so we bucket that observation by hour and keep it here.
//
// Buckets are upserted, so several syncs inside the same hour overwrite each
// other rather than accumulating.

import { hourBucket } from "@/lib/equity-intraday.server";

type MinimalDb = {
  from: (table: string) => {
    upsert: (values: unknown, options?: { onConflict?: string }) => Promise<{ error?: unknown }>;
  };
};

export type IntradayPriceInput = { symbol: string; price: number };

/** Drop unusable observations and keep the last price seen per symbol. */
export function dedupePricePoints(points: IntradayPriceInput[]): IntradayPriceInput[] {
  const bySymbol = new Map<string, number>();
  for (const p of points) {
    const price = Number(p?.price);
    const symbol = String(p?.symbol ?? "").trim();
    if (!symbol || !Number.isFinite(price) || price <= 0) continue;
    bySymbol.set(symbol, price);
  }
  return Array.from(bySymbol, ([symbol, price]) => ({ symbol, price }));
}

/**
 * Record (or overwrite) hourly price points for a set of symbols.
 * Never throws: intraday prices are telemetry for charting, so a failure here
 * must not roll back the broker sync that produced them.
 */
export async function recordIntradayPrices(
  db: MinimalDb,
  points: IntradayPriceInput[],
  at: Date = new Date(),
  source = "broker",
): Promise<number> {
  const rows = dedupePricePoints(points);
  if (rows.length === 0) return 0;
  const bucket = hourBucket(at);
  try {
    const res = await db.from("price_intraday").upsert(
      rows.map((r) => ({
        symbol: r.symbol,
        bucket_hour: bucket,
        price: r.price,
        source,
      })),
      { onConflict: "symbol,bucket_hour" },
    );
    // supabase-js resolves with { error } instead of throwing, so an RLS
    // rejection would otherwise look like a successful write.
    if (res?.error) {
      console.warn("intraday price points rejected", res.error);
      return 0;
    }
    return rows.length;
  } catch (e) {
    console.warn("intraday price points skipped", e);
    return 0;
  }
}
