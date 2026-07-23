// Server functions exposed to the UI. All authenticated via requireSupabaseAuth.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const RiskEnum = z.enum(["conservative", "balanced", "aggressive"]);
const AssetClassEnum = z.enum(["stock", "etf", "crypto", "commodity", "fx"]);

const CreatePortfolioSchema = z.object({
  name: z.string().min(1).max(80).default("My Portfolio"),
  starting_cash: z.number().min(10).max(1_000_000).default(1000),
  currency: z.enum(["GBP", "USD", "EUR"]).default("GBP"),
  risk_level: RiskEnum.default("balanced"),
  universe: z.array(AssetClassEnum).min(1).default(["stock", "etf", "crypto", "commodity", "fx"]),
  mode: z.enum(["backtest", "paper"]).default("backtest"),
});

export const createPortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CreatePortfolioSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("portfolios")
      .insert({
        user_id: context.userId,
        name: data.name,
        starting_cash: data.starting_cash,
        current_cash: data.starting_cash,
        currency: data.currency,
        risk_level: data.risk_level,
        universe: data.universe,
        mode: data.mode,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });

export const listPortfolios = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("portfolios")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  });

export const getPortfolio = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const [{ data: portfolio }, { data: holdings }, { data: trades }, { data: decisions }, { data: equity }] =
      await Promise.all([
        context.supabase.from("portfolios").select("*").eq("id", data.id).single(),
        context.supabase.from("holdings").select("*").eq("portfolio_id", data.id),
        context.supabase
          .from("trades")
          .select("*")
          .eq("portfolio_id", data.id)
          .order("executed_at", { ascending: false })
          .limit(200),
        context.supabase
          .from("decisions")
          .select("*")
          .eq("portfolio_id", data.id)
          .order("run_date", { ascending: false })
          .limit(60),
        context.supabase
          .from("equity_snapshots")
          .select("*")
          .eq("portfolio_id", data.id)
          .order("snapshot_date", { ascending: true }),
      ]);
    if (!portfolio) throw new Error("Portfolio not found");
    return {
      portfolio,
      holdings: holdings ?? [],
      trades: trades ?? [],
      decisions: decisions ?? [],
      equity: equity ?? [],
    };
  });

export const deletePortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("portfolios").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const resetPortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { data: p } = await context.supabase
      .from("portfolios")
      .select("starting_cash")
      .eq("id", data.id)
      .single();
    if (!p) throw new Error("Portfolio not found");
    await context.supabase.from("holdings").delete().eq("portfolio_id", data.id);
    await context.supabase.from("trades").delete().eq("portfolio_id", data.id);
    await context.supabase.from("decisions").delete().eq("portfolio_id", data.id);
    await context.supabase.from("equity_snapshots").delete().eq("portfolio_id", data.id);
    await context.supabase
      .from("portfolios")
      .update({ current_cash: p.starting_cash, last_run_date: null })
      .eq("id", data.id);
    return { ok: true };
  });

export const runOneDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        as_of: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    // Verify user owns portfolio (RLS via context.supabase)
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolio_id)
      .single();
    if (!owned) throw new Error("Portfolio not found");
    const { runDailyTick } = await import("./trading-engine.server");
    const asOf = data.as_of ?? new Date().toISOString().slice(0, 10);
    const result = await runDailyTick(data.portfolio_id, asOf);
    return {
      briefing: result.decision.briefing,
      rationale: result.decision.rationale,
      totalValue: result.totalValue,
      executedCount: result.executed.filter((e) => !e.rejected).length,
    };
  });

export const runBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        // number of trading days to simulate, ending today
        days: z.number().int().min(3).max(30).default(10),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolio_id)
      .single();
    if (!owned) throw new Error("Portfolio not found");
    const { runDailyTick, snapshotPortfolio } = await import("./trading-engine.server");

    // Reset portfolio first
    const { data: p } = await context.supabase
      .from("portfolios")
      .select("starting_cash")
      .eq("id", data.portfolio_id)
      .single();
    if (p) {
      await context.supabase.from("holdings").delete().eq("portfolio_id", data.portfolio_id);
      await context.supabase.from("trades").delete().eq("portfolio_id", data.portfolio_id);
      await context.supabase.from("decisions").delete().eq("portfolio_id", data.portfolio_id);
      await context.supabase
        .from("equity_snapshots")
        .delete()
        .eq("portfolio_id", data.portfolio_id);
      await context.supabase
        .from("portfolios")
        .update({ current_cash: p.starting_cash, last_run_date: null })
        .eq("id", data.portfolio_id);
    }

    // Build list of business days (skip weekends) ending yesterday
    const dates: string[] = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    let cursor = new Date(today);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (dates.length < data.days) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) dates.unshift(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (dates.length > 60) break;
    }

    let lastTotal = 0;
    for (const d of dates) {
      try {
        const r = await runDailyTick(data.portfolio_id, d, { skipNews: true });
        lastTotal = r.totalValue;
      } catch (err) {
        console.error(`backtest ${d} failed`, err);
        await snapshotPortfolio(data.portfolio_id, d).catch(() => {});
      }
    }
    return { ok: true, days: dates.length, finalValue: lastTotal };
  });

// ---------- Comparison ----------

function computeMetrics(equity: { snapshot_date: string; total_value: number }[], startingCash: number) {
  if (equity.length === 0) {
    return {
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      sharpe: 0,
      volatilityPct: 0,
      bestDayPct: 0,
      worstDayPct: 0,
      days: 0,
    };
  }
  const values = equity.map((e) => Number(e.total_value));
  const finalValue = values[values.length - 1];
  const totalReturnPct = ((finalValue - startingCash) / startingCash) * 100;

  // Max drawdown
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Daily returns based on previous close
  const rets: number[] = [];
  let prev = startingCash;
  for (const v of values) {
    if (prev > 0) rets.push((v - prev) / prev);
    prev = v;
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const std = Math.sqrt(variance);
  // Annualise assuming ~252 trading days
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const volatilityPct = std * Math.sqrt(252) * 100;
  const best = rets.length ? Math.max(...rets) : 0;
  const worst = rets.length ? Math.min(...rets) : 0;

  return {
    totalReturnPct,
    maxDrawdownPct: maxDD * 100,
    sharpe,
    volatilityPct,
    bestDayPct: best * 100,
    worstDayPct: worst * 100,
    days: values.length,
  };
}

export const getComparison = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ portfolio_ids: z.array(z.string().uuid()).min(1).max(6) }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: portfolios, error } = await context.supabase
      .from("portfolios")
      .select("*")
      .in("id", data.portfolio_ids);
    if (error) throw new Error(error.message);
    const results = await Promise.all(
      (portfolios ?? []).map(async (p) => {
        const { data: equity } = await context.supabase
          .from("equity_snapshots")
          .select("snapshot_date,total_value")
          .eq("portfolio_id", p.id)
          .order("snapshot_date", { ascending: true });
        const series = (equity ?? []).map((e) => ({
          snapshot_date: e.snapshot_date as string,
          total_value: Number(e.total_value),
        }));
        return {
          portfolio: {
            id: p.id,
            name: p.name,
            currency: p.currency,
            risk_level: p.risk_level,
            universe: p.universe,
            starting_cash: Number(p.starting_cash),
            mode: p.mode,
          },
          series,
          metrics: computeMetrics(series, Number(p.starting_cash)),
        };
      }),
    );
    return { results };
  });

export const runBacktestMany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_ids: z.array(z.string().uuid()).min(1).max(6),
        days: z.number().int().min(3).max(30).default(10),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id")
      .in("id", data.portfolio_ids);
    const ids = (owned ?? []).map((o) => o.id);
    const { runDailyTick, snapshotPortfolio } = await import("./trading-engine.server");

    // Build shared trading-day list
    const dates: string[] = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cursor = new Date(today);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (dates.length < data.days) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) dates.unshift(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (dates.length > 60) break;
    }

    for (const id of ids) {
      const { data: p } = await context.supabase
        .from("portfolios")
        .select("starting_cash")
        .eq("id", id)
        .single();
      if (!p) continue;
      await context.supabase.from("holdings").delete().eq("portfolio_id", id);
      await context.supabase.from("trades").delete().eq("portfolio_id", id);
      await context.supabase.from("decisions").delete().eq("portfolio_id", id);
      await context.supabase.from("equity_snapshots").delete().eq("portfolio_id", id);
      await context.supabase
        .from("portfolios")
        .update({ current_cash: p.starting_cash, last_run_date: null })
        .eq("id", id);
      for (const d of dates) {
        try {
          await runDailyTick(id, d, { skipNews: true });
        } catch (err) {
          console.error(`backtest ${id} ${d} failed`, err);
          await snapshotPortfolio(id, d).catch(() => {});
        }
      }
    }
    return { ok: true, ran: ids.length, days: dates.length };
  });
