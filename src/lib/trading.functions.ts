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
