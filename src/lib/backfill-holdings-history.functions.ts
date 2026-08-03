// One-shot recompute + backfill for the holdings sparklines.
//
// There is no cached "series" table — sparklines are derived at render time
// from `holdings` (avg_cost, opened_at, quantity, symbol) plus `price_cache`.
// Historic graph glitches came from two sources:
//   1) `price_cache` gaps between opened_at and today (fewer plot points).
//   2) Symbol/casing/MIC-suffix mismatches that missed the cache lookup.
//
// This job walks every currently-held position, warms `price_cache` back to
// each holding's opened_at via the existing `getDailyCandles` helper (which
// upserts fresh Yahoo data), rebuilds the series with the same pure builder
// the server function uses, and runs the runtime auditor over the result.
// Idempotent — safe to run any number of times.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { buildHoldingSeries } from "@/lib/build-holding-series";
import {
  auditHoldingSeriesBatch,
  formatIssue,
  type SeriesSanityIssue,
} from "@/lib/holdings-series-sanity";

import { MIC_TO_YAHOO, resolveYahoo } from "./backfill-holdings-history.helpers";
import type { BackfillReport } from "./backfill-holdings-history.helpers";
export type { BackfillReport };

export const backfillHoldingsHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ dryRun: z.boolean().optional().default(false) }).parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<BackfillReport> => {
    const { getDailyCandles } = await import("@/lib/market-data.server");

    const { data: holdings } = await context.supabase
      .from("holdings")
      .select("portfolio_id, symbol, quantity, avg_cost, opened_at, asset_class")
      .gt("quantity", 0);
    const list = holdings ?? [];

    // Compute the earliest opened_at per resolved-Yahoo symbol so we only
    // fetch as much history as anyone actually needs.
    const now = Date.now();
    const perSymbolDays = new Map<string, number>();
    const originalToYahoo = new Map<string, string>();
    for (const h of list) {
      const y = resolveYahoo(h.symbol);
      originalToYahoo.set(h.symbol, y);
      const opened = h.opened_at ? new Date(h.opened_at).getTime() : now;
      const days = Math.min(730, Math.max(30, Math.ceil((now - opened) / 86_400_000) + 5));
      perSymbolDays.set(y, Math.max(perSymbolDays.get(y) ?? 0, days));
    }

    const perSymbol: BackfillReport["perSymbol"] = [];
    let refreshed = 0;
    let failed = 0;

    if (!data.dryRun) {
      // Refresh cache in parallel with a modest cap to avoid Yahoo throttling.
      const entries = Array.from(perSymbolDays.entries());
      const CONCURRENCY = 6;
      for (let i = 0; i < entries.length; i += CONCURRENCY) {
        const batch = entries.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async ([sym, days]) => {
            try {
              await getDailyCandles(sym, days);
              refreshed++;
              perSymbol.push({ symbol: sym, refreshed: true, days });
            } catch (err) {
              failed++;
              perSymbol.push({
                symbol: sym,
                refreshed: false,
                days,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        );
      }
    } else {
      for (const [sym, days] of perSymbolDays) {
        perSymbol.push({ symbol: sym, refreshed: false, days });
      }
    }

    // Re-read the refreshed cache and rebuild every holding's series so we
    // can audit the post-backfill state end-to-end.
    const symbols = Array.from(perSymbolDays.keys());
    const earliestSince = new Date(now - 730 * 86_400_000).toISOString().slice(0, 10);
    const { data: prices } = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close")
      .in("symbol", symbols)
      .gte("price_date", earliestSince)
      .order("price_date", { ascending: true });

    const bySymbol = new Map<string, Array<{ date: string; close: number }>>();
    for (const p of prices ?? []) {
      const arr = bySymbol.get(p.symbol) ?? [];
      arr.push({ date: p.price_date as string, close: Number(p.close) });
      bySymbol.set(p.symbol, arr);
    }

    const series = list.map((h) =>
      buildHoldingSeries(
        {
          symbol: h.symbol,
          quantity: h.quantity,
          avg_cost: h.avg_cost,
          opened_at: h.opened_at,
          asset_class: h.asset_class,
        },
        bySymbol.get(originalToYahoo.get(h.symbol) ?? h.symbol) ?? [],
      ),
    );
    const issues = auditHoldingSeriesBatch(series);
    for (const i of issues) console.warn(formatIssue(i));

    const portfolios = new Set(list.map((h) => h.portfolio_id));
    return {
      portfoliosScanned: portfolios.size,
      holdingsScanned: list.length,
      symbolsRefreshed: refreshed,
      symbolsFailed: failed,
      seriesBuilt: series.length,
      issues,
      perSymbol,
    };
  });
