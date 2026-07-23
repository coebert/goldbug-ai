import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const IdSchema = z.object({ portfolioId: z.string().uuid() });

export const getSignalPerformance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows } = await context.supabase
      .from("signal_performance")
      .select("signal_name, window_days, samples, hits, hit_rate, avg_edge_bps, weight_avg, as_of")
      .eq("portfolio_id", data.portfolioId)
      .order("signal_name", { ascending: true });
    return rows ?? [];
  });

export const getCorrelationMatrix = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: holdings } = await context.supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost, asset_class")
      .eq("portfolio_id", data.portfolioId);
    const list = (holdings ?? []).filter((h) => Number(h.quantity) > 0);
    if (list.length < 2) return { symbols: [] as string[], matrix: [] as number[][], exposures: [] as Array<{ symbol: string; value: number }> };
    const symbols = list.map((h) => h.symbol);
    const { buildCorrelationMap } = await import("./portfolio-optimizer.server");
    const asOf = new Date().toISOString().slice(0, 10);
    const corr = await buildCorrelationMap(symbols, asOf).catch(() => new Map<string, Map<string, number>>());
    const matrix: number[][] = symbols.map((a) =>
      symbols.map((b) => {
        if (a === b) return 1;
        return corr.get(a)?.get(b) ?? corr.get(b)?.get(a) ?? 0;
      }),
    );
    const exposures = list.map((h) => ({
      symbol: h.symbol,
      value: Number(h.quantity) * Number(h.avg_cost),
    }));
    return { symbols, matrix, exposures };
  });

export const getSectorScores = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const asOf = new Date().toISOString().slice(0, 10);
    const { data: today } = await context.supabase
      .from("sector_scores")
      .select("sector, etf_symbol, momentum_30d, momentum_90d, score, rank, as_of")
      .eq("as_of", asOf)
      .order("rank", { ascending: true });
    if (today && today.length > 0) return today;
    const { data: latest } = await context.supabase
      .from("sector_scores")
      .select("sector, etf_symbol, momentum_30d, momentum_90d, score, rank, as_of")
      .order("as_of", { ascending: false })
      .limit(20);
    return latest ?? [];
  });

export const getPortfolioStress = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data }) => {
    const { computePortfolioStress } = await import("./portfolio-stress.server");
    const asOf = new Date().toISOString().slice(0, 10);
    return computePortfolioStress(data.portfolioId, asOf);
  });
