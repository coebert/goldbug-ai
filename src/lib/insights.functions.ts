import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const IdSchema = z.object({ portfolioId: z.string().uuid() });

export const getGlobalSignalDecay = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows } = await context.supabase
      .from("signal_performance")
      .select("portfolio_id, signal_name, samples, hits, hit_rate, avg_edge_bps, weight_avg, as_of")
      .order("as_of", { ascending: false })
      .limit(2000);
    const latest = new Map<string, NonNullable<typeof rows>[number]>();
    for (const r of rows ?? []) {
      const key = `${r.portfolio_id}|${r.signal_name}`;
      if (!latest.has(key)) latest.set(key, r);
    }
    const agg = new Map<string, { samples: number; hits: number; edgeSum: number; weightSum: number; portfolios: Set<string> }>();
    for (const r of latest.values()) {
      const cur = agg.get(r.signal_name) ?? { samples: 0, hits: 0, edgeSum: 0, weightSum: 0, portfolios: new Set<string>() };
      const n = Number(r.samples) || 0;
      cur.samples += n;
      cur.hits += Number(r.hits) || 0;
      cur.edgeSum += (Number(r.avg_edge_bps) || 0) * n;
      cur.weightSum += (Number(r.weight_avg) || 0) * n;
      cur.portfolios.add(r.portfolio_id);
      agg.set(r.signal_name, cur);
    }
    return Array.from(agg.entries()).map(([signal_name, v]) => ({
      signal_name,
      samples: v.samples,
      hit_rate: v.samples > 0 ? v.hits / v.samples : null,
      avg_edge_bps: v.samples > 0 ? v.edgeSum / v.samples : null,
      weight_avg: v.samples > 0 ? v.weightSum / v.samples : null,
      portfolio_count: v.portfolios.size,
    })).sort((a, b) => (b.avg_edge_bps ?? -Infinity) - (a.avg_edge_bps ?? -Infinity));
  });

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
        .select("tuned_at, oos_score, train_score, sma_fast, sma_slow, rsi_period, kelly_cap")
        .eq("portfolio_id", data.portfolioId)
        .order("tuned_at", { ascending: false })
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

export const getShadowVariantReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: p } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (!p) return { variant_name: "contrarian_v1", samples: 0, avg_agreement: null, total_divergences: 0, recent: [] as never[] };
    const { getShadowReport } = await import("./ab-testing.server");
    return getShadowReport(data.portfolioId);
  });
