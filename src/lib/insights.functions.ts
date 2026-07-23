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

export const getLearningDiagnostics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data, context }) => {
    const [calib, cfRows, hpRows] = await Promise.all([
      context.supabase
        .from("calibration_snapshots")
        .select("brier_score, samples, hit_rate, avg_conviction, global_size_mult, notes, as_of")
        .eq("portfolio_id", data.portfolioId)
        .order("as_of", { ascending: false })
        .limit(1)
        .maybeSingle(),
      context.supabase
        .from("counterfactuals")
        .select("id, symbol, block_category, block_reason, forward_return_5d, evaluated_at, as_of")
        .eq("portfolio_id", data.portfolioId)
        .not("forward_return_5d", "is", null)
        .order("as_of", { ascending: false })
        .limit(200),
      context.supabase
        .from("hyperparam_history")
        .select("run_date, validation_score, hyperparams")
        .eq("portfolio_id", data.portfolioId)
        .order("run_date", { ascending: false })
        .limit(5),
    ]);

    const cfs = cfRows.data ?? [];
    const evaluated = cfs.length;
    const rets = cfs.map((c) => Number(c.forward_return_5d) || 0);
    const avgRegret = evaluated ? rets.reduce((a, b) => a + b, 0) / evaluated : null;
    const costlyBlocks = cfs.filter((c) => (Number(c.forward_return_5d) || 0) > 0.02).length;
    const savedBlocks = cfs.filter((c) => (Number(c.forward_return_5d) || 0) < -0.02).length;
    const byCategory = new Map<string, { n: number; sum: number }>();
    for (const c of cfs) {
      const k = (c.block_category as string) || "other";
      const cur = byCategory.get(k) ?? { n: 0, sum: 0 };
      cur.n++;
      cur.sum += Number(c.forward_return_5d) || 0;
      byCategory.set(k, cur);
    }

    return {
      calibration: calib.data ?? null,
      counterfactuals: {
        evaluated,
        avg_regret_5d: avgRegret,
        costly_blocks: costlyBlocks,
        saved_blocks: savedBlocks,
        by_category: Array.from(byCategory.entries()).map(([category, v]) => ({
          category,
          n: v.n,
          avg_return_5d: v.n ? v.sum / v.n : 0,
        })),
      },
      walk_forward: hpRows.data ?? [],
    };
  });
