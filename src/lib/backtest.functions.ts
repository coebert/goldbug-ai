// Backtest server functions (single-portfolio, multi-portfolio, long-horizon).
// Extracted from trading.functions.ts (Phase 3 module decoupling).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

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
    const cursor = new Date(today);
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
        const r = await runDailyTick(data.portfolio_id, d, { skipNews: true, forceAi: true });
        lastTotal = r.totalValue;
      } catch (err) {
        console.error(`backtest ${d} failed`, err);
        await snapshotPortfolio(data.portfolio_id, d).catch(() => {});
      }
    }

    // Compute key performance metrics for this backtest run.
    const { computeBacktestMetrics } = await import("./backtest-metrics");
    const [{ data: eqRows }, { data: tradeRows }, { data: fundRows }] = await Promise.all([
      context.supabase
        .from("equity_snapshots")
        .select("snapshot_date,total_value")
        .eq("portfolio_id", data.portfolio_id)
        .order("snapshot_date", { ascending: true }),
      context.supabase
        .from("trades")
        .select("trade_date,executed_at,side,symbol,quantity,price")
        .eq("portfolio_id", data.portfolio_id)
        .order("trade_date", { ascending: true }),
      context.supabase
        .from("sim_fund_events")
        .select("created_at,amount")
        .eq("portfolio_id", data.portfolio_id)
        .order("created_at", { ascending: true }),
    ]);
    const startingCash = Number(p?.starting_cash ?? 0);
    const metrics = computeBacktestMetrics(
      (eqRows ?? []).map((r) => ({
        snapshot_date: r.snapshot_date as string,
        total_value: Number(r.total_value),
      })),
      (tradeRows ?? []).map((t) => ({
        trade_date: t.trade_date as string,
        executed_at: (t.executed_at as string | null) ?? null,
        side: t.side as "buy" | "sell",
        symbol: t.symbol as string,
        quantity: Number(t.quantity),
        price: Number(t.price),
      })),
      startingCash,
      (fundRows ?? []).map((f) => ({
        date: String(f.created_at ?? "").slice(0, 10),
        amount: Number(f.amount),
      })),
    );

    return { ok: true, days: dates.length, finalValue: lastTotal, metrics };
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
          await runDailyTick(id, d, { skipNews: true, forceAi: true });
        } catch (err) {
          console.error(`backtest ${id} ${d} failed`, err);
          await snapshotPortfolio(id, d).catch(() => {});
        }
      }
    }
    return { ok: true, ran: ids.length, days: dates.length };
  });

export const runLongHorizonBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        rebalance: z.enum(["monthly", "quarterly"]).default("monthly"),
        top_k: z.number().int().min(2).max(12).default(6),
        commission_bps: z.number().min(0).max(500).default(5),
        slippage_bps: z.number().min(0).max(500).default(10),
        min_trade_value: z.number().min(0).max(100000).default(25),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: p, error } = await context.supabase
      .from("portfolios")
      .select("id, starting_cash, currency, risk_level, risk_config")
      .eq("id", data.portfolio_id)
      .single();
    if (error || !p) throw new Error("Portfolio not found");
    const { runLongHorizonBacktest: run, LONG_HORIZON_UNIVERSE } = await import(
      "./long-horizon.server"
    );
    const result = await run({
      from: data.from,
      to: data.to,
      startingCash: Number(p.starting_cash),
      currency: p.currency ?? "GBP",
      riskLevel: p.risk_level ?? "balanced",
      riskConfig: p.risk_config,
      universe: LONG_HORIZON_UNIVERSE,
      rebalance: data.rebalance,
      topK: data.top_k,
      execution: {
        commission_bps: data.commission_bps,
        slippage_bps: data.slippage_bps,
        min_trade_value: data.min_trade_value,
      },
    });
    return result;
  });
