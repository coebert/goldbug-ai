import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { resolvePriceSymbol } from "@/lib/price-symbol";
import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";
import {
  compareHolding,
  comparePortfolio,
  pickBenchmark,
  FALLBACK_BENCHMARK,
  type PortfolioComparison,
  type PricePoint,
} from "@/lib/relative-strength";

/** ~4 months of sessions covers every trailing window plus a recent purchase. */
const LOOKBACK_DAYS = 200;

/**
 * Continuously score the portfolio's owned stocks against the market average
 * for their venue. Reads the shared daily price cache only, so it is cheap
 * enough to poll on a timer while the dashboard is open.
 */
export const getRelativeStrength = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<PortfolioComparison> => {
    const empty = comparePortfolio([], null);

    const { data: holdings } = await context.supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost, opened_at, asset_class")
      .eq("portfolio_id", data.portfolioId);

    const list = (holdings ?? []).filter((h) => Number(h.quantity) > 0);
    if (list.length === 0) return empty;

    const benchmarks = list.map((h) => pickBenchmark(h.symbol, h.asset_class));
    const priceKeys = new Set<string>();
    for (const h of list) priceKeys.add(resolvePriceSymbol(h.symbol).toUpperCase());
    for (const b of benchmarks) priceKeys.add(b.symbol.toUpperCase());
    priceKeys.add(FALLBACK_BENCHMARK.symbol.toUpperCase());

    const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const { data: prices } = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close")
      .in("symbol", [...priceKeys])
      .gte("price_date", sinceIso)
      .order("price_date", { ascending: true });

    // Normalise LSE pence quotes to base units so the since-purchase leg (which
    // compares against a GBP cost basis) is unit-consistent. Window returns are
    // ratios and unaffected either way.
    const bySymbol = new Map<string, PricePoint[]>();
    for (const row of prices ?? []) {
      const key = String(row.symbol).toUpperCase();
      const arr = bySymbol.get(key) ?? [];
      arr.push({
        date: String(row.price_date),
        close: normalizeLseDisplayPriceToBase(key, Number(row.close)),
      });
      bySymbol.set(key, arr);
    }

    const seriesFor = (sym: string): PricePoint[] => bySymbol.get(sym.toUpperCase()) ?? [];

    const rows = list.map((h, i) => {
      let benchmark = benchmarks[i]!;
      let benchSeries = seriesFor(benchmark.symbol);
      if (benchSeries.length === 0) {
        benchmark = FALLBACK_BENCHMARK;
        benchSeries = seriesFor(FALLBACK_BENCHMARK.symbol);
      }
      return compareHolding({
        holding: {
          symbol: h.symbol,
          quantity: Number(h.quantity),
          avgCost: Number(h.avg_cost),
          openedAt: h.opened_at ? String(h.opened_at) : null,
          assetClass: h.asset_class ?? null,
        },
        series: seriesFor(resolvePriceSymbol(h.symbol)),
        benchmark,
        benchmarkSeries: benchSeries,
      });
    });

    const asOf =
      [...bySymbol.values()]
        .map((s) => (s.length > 0 ? s[s.length - 1]!.date : ""))
        .sort()
        .pop() ?? null;

    return comparePortfolio(rows, asOf || null);
  });
