// Server functions for the Trade-tab strategy builder: per-symbol entry,
// stop-loss and take-profit rules, plus the per-position drawdown budget.
// Order-placing calls are step-up (AAL2) gated because they move real money on
// live portfolios.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAal2 } from "@/lib/_server/require-aal2";
import { z } from "zod";

const ASSET = z.enum(["stock", "etf", "crypto", "commodity", "fx"]);

export const listStrategies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ portfolioId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("trade_strategies")
      .select("*")
      .eq("portfolio_id", data.portfolioId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const { data: p } = await context.supabase
      .from("portfolios")
      .select("holding_dd_budget_pct, holding_dd_autoclose")
      .eq("id", data.portfolioId)
      .maybeSingle();
    return {
      strategies: rows ?? [],
      ddBudgetPct: p?.holding_dd_budget_pct != null ? Number(p.holding_dd_budget_pct) : null,
      ddAutoClose: Boolean(p?.holding_dd_autoclose),
    };
  });

export const saveStrategy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().optional(),
        portfolioId: z.string().uuid(),
        symbol: z.string().min(1).max(32),
        assetClass: ASSET.default("etf"),
        instrumentCcy: z.string().min(3).max(4).default("GBP"),
        quantity: z.number().positive(),
        entryPrice: z.number().positive(),
        entryMode: z.enum(["limit", "breakout", "market"]).default("limit"),
        stopLoss: z.number().positive().nullable().optional(),
        takeProfit: z.number().positive().nullable().optional(),
        enabled: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const row = {
      user_id: context.userId,
      portfolio_id: data.portfolioId,
      symbol: data.symbol.trim().toUpperCase(),
      asset_class: data.assetClass,
      instrument_ccy: data.instrumentCcy.toUpperCase(),
      quantity: data.quantity,
      entry_price: data.entryPrice,
      entry_mode: data.entryMode,
      stop_loss: data.stopLoss ?? null,
      take_profit: data.takeProfit ?? null,
      enabled: data.enabled,
    };
    if (data.stopLoss != null && data.stopLoss >= data.entryPrice) {
      throw new Error("Stop-loss must sit below the entry price.");
    }
    if (data.takeProfit != null && data.takeProfit <= data.entryPrice) {
      throw new Error("Take-profit must sit above the entry price.");
    }
    const { error } = await context.supabase
      .from("trade_strategies")
      .upsert(row, { onConflict: "portfolio_id,symbol" });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const deleteStrategy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("trade_strategies").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const setDrawdownBudget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        budgetPct: z.number().min(0.5).max(90).nullable(),
        autoClose: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("portfolios")
      .update({
        holding_dd_budget_pct: data.budgetPct,
        holding_dd_autoclose: data.autoClose,
      })
      .eq("id", data.portfolioId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/** Evaluates all strategies + the drawdown budget and places any triggered orders. */
export const runStrategies = createServerFn({ method: "POST" })
  .middleware([requireAal2])
  .inputValidator((input: unknown) => z.object({ portfolioId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: p, error: pErr } = await supabase
      .from("portfolios")
      .select(
        "id, mode, status, currency, current_cash, cash_by_ccy, live_paused, holding_dd_budget_pct, holding_dd_autoclose",
      )
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (pErr || !p) throw new Error("Portfolio not found or not accessible.");

    const { data: rows } = await supabase
      .from("trade_strategies")
      .select("*")
      .eq("portfolio_id", data.portfolioId);

    const { evaluateStrategies, evaluateHoldingDrawdownBudget } = await import(
      "@/lib/strategy-engine.server"
    );
    const portfolio = {
      id: p.id,
      mode: String(p.mode),
      status: String(p.status),
      currency: String(p.currency),
      current_cash: Number(p.current_cash),
      cash_by_ccy: (p.cash_by_ccy as Record<string, number> | null) ?? null,
      live_paused: Boolean(p.live_paused),
      holding_dd_budget_pct:
        p.holding_dd_budget_pct != null ? Number(p.holding_dd_budget_pct) : null,
      holding_dd_autoclose: Boolean(p.holding_dd_autoclose),
    };

    const strategyActions = await evaluateStrategies({
      supabase,
      userId,
      portfolio,
      strategies: (rows ?? []).map((r) => ({
        id: r.id,
        portfolio_id: r.portfolio_id,
        symbol: r.symbol,
        asset_class: String(r.asset_class),
        instrument_ccy: r.instrument_ccy,
        quantity: Number(r.quantity),
        entry_price: Number(r.entry_price),
        entry_mode: r.entry_mode,
        stop_loss: r.stop_loss != null ? Number(r.stop_loss) : null,
        take_profit: r.take_profit != null ? Number(r.take_profit) : null,
        enabled: r.enabled,
        status: r.status,
      })),
    });

    const ddActions = await evaluateHoldingDrawdownBudget({ supabase, userId, portfolio });
    return { actions: [...strategyActions, ...ddActions] };
  });
