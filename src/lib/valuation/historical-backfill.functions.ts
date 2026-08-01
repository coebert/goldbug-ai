import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { BackfillRunResult } from "@/lib/valuation/historical-backfill.server";

/**
 * One-off: revalue every stored equity snapshot through the valuation kernel.
 * Warms `price_cache` first (unless disabled) so the derived holdings series
 * and the per-day marks this job depends on have no gaps.
 */
export const runValuationHistoryBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid().optional(),
        dryRun: z.boolean().optional().default(false),
        warmPrices: z.boolean().optional().default(true),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<BackfillRunResult & { symbolsWarmed: number }> => {
    let symbolsWarmed = 0;

    if (data.warmPrices) {
      try {
        const { getDailyCandles } = await import("@/lib/market-data.server");
        const { resolvePriceSymbol } = await import("@/lib/price-symbol");
        let holdingsQuery = context.supabase
          .from("holdings")
          .select("symbol, opened_at, portfolio_id")
          .gt("quantity", 0);
        if (data.portfolioId) holdingsQuery = holdingsQuery.eq("portfolio_id", data.portfolioId);
        const { data: holdings } = await holdingsQuery;

        const now = Date.now();
        const perSymbol = new Map<string, number>();
        for (const h of holdings ?? []) {
          const sym = resolvePriceSymbol(String((h as { symbol: unknown }).symbol));
          const opened = (h as { opened_at?: string | null }).opened_at;
          const openedMs = opened ? new Date(opened).getTime() : now;
          const days = Math.min(730, Math.max(30, Math.ceil((now - openedMs) / 86_400_000) + 5));
          perSymbol.set(sym, Math.max(perSymbol.get(sym) ?? 0, days));
        }

        const entries = [...perSymbol.entries()];
        const CONCURRENCY = 6;
        for (let i = 0; i < entries.length; i += CONCURRENCY) {
          await Promise.all(
            entries.slice(i, i + CONCURRENCY).map(async ([sym, days]) => {
              try {
                await getDailyCandles(sym, days);
                symbolsWarmed += 1;
              } catch {
                /* a cold symbol falls back to carry-forward / cost basis */
              }
            }),
          );
        }
      } catch {
        /* price warming is best-effort; the revaluation still runs */
      }
    }

    const { backfillValuationHistory } = await import(
      "@/lib/valuation/historical-backfill.server"
    );
    const run = await backfillValuationHistory(context.supabase, {
      portfolioIds: data.portfolioId ? [data.portfolioId] : undefined,
      dryRun: data.dryRun,
      since: data.since,
    });

    return { ...run, symbolsWarmed };
  });

export type { BackfillRunResult };
