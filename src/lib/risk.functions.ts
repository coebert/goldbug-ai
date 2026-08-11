// Risk config, execution calibration, portfolio reset, and manual daily tick.
// Extracted from trading.functions.ts (Phase 3). Schemas are inlined inside
// .inputValidator to stay safe under the tss-serverfn-split transform.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const updateRiskConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => {
    const RiskConfigSchema = z.object({
      asset_class_limits: z
        .object({
          stock: z.number().min(0).max(1).optional(),
          etf: z.number().min(0).max(1).optional(),
          crypto: z.number().min(0).max(1).optional(),
          commodity: z.number().min(0).max(1).optional(),
          fx: z.number().min(0).max(1).optional(),
        })
        .partial()
        .default({}),
      per_symbol_limit_pct: z.number().min(0).max(1).nullable().default(null),
      stop_loss_pct: z.number().min(0).max(0.9).default(0.1),
      take_profit_pct: z.number().min(0).max(5).default(0.25),
      atr_trailing_mult: z.number().min(0).max(10).default(3),
      max_hold_days: z.number().int().min(0).max(3650).default(0),
      volatility_sizing: z.boolean().default(true),
      vol_target_pct: z.number().min(0.001).max(0.1).default(0.015),
      max_daily_loss_pct: z.number().min(0).max(0.9).default(0.05),
      max_drawdown_halt_pct: z.number().min(0).max(0.9).default(0.20),
      atr_scaled_stop_enabled: z.boolean().optional(),
      atr_scaled_stop_floor_pct: z.number().min(0).max(0.5).optional(),
      take_profit_enabled: z.boolean().optional(),
      atr_take_profit_enabled: z.boolean().optional(),
      take_profit_atr_mult: z.number().min(0).max(20).optional(),
      atr_take_profit_floor_pct: z.number().min(0).max(2).optional(),
      atr_take_profit_cap_pct: z.number().min(0).max(5).optional(),
      diversification_tilt: z.enum(["off", "balanced", "strong"]).optional(),
      trading_style: z.enum(["position", "swing"]).optional(),
      swing_min_hold_days: z.number().int().min(0).max(30).optional(),
      risk_level: z.number().int().min(1).max(5).optional(),
      fx_currency_limits: z
        .record(z.string().regex(/^[A-Z]{3}$/), z.number().min(0).max(1))
        .optional(),
    });

    return z
      .object({
        portfolio_id: z.string().uuid(),
        risk_config: RiskConfigSchema,
      })
      .parse(i);
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("portfolios")
      .update({ risk_config: data.risk_config })
      .eq("id", data.portfolio_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// -----------------------------------------------------------------------
// Execution calibration — estimates spread / slippage / commission from
// recent OHLCV and updates portfolios.risk_config.execution_params.
// -----------------------------------------------------------------------
export const calibrateExecution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        window_days: z.number().int().min(20).max(365).default(90),
        apply: z.boolean().default(true),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: p, error } = await context.supabase
      .from("portfolios")
      .select("id, universe, risk_config")
      .eq("id", data.portfolio_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!p) throw new Error("Portfolio not found");

    const { filterUniverse, parseRiskConfig } = await import("./universe.server");
    const { calibrateExecution: run } = await import("./execution-calibration.server");
    const classes = Array.isArray(p.universe) ? (p.universe as string[]) : [];
    const symbols = filterUniverse(classes as Parameters<typeof filterUniverse>[0]).map((u) => u.symbol);
    if (!symbols.length) throw new Error("Portfolio universe is empty");

    const summary = await run(symbols, { lookbackDays: data.window_days });

    if (data.apply) {
      const cfg = parseRiskConfig(p.risk_config);
      const nextCfg = {
        ...cfg,
        execution_params: {
          slippage_bps: summary.recommended.slippage_bps,
          commission_bps: summary.recommended.commission_bps,
          spread_atr_frac: summary.recommended.spread_atr_frac,
          adv_participation: summary.recommended.adv_participation,
          min_trade_value: summary.recommended.min_trade_value,
        },
        execution_calibration: {
          as_of: summary.as_of,
          window_days: summary.window_days,
          n_symbols: summary.n_symbols,
          notes: summary.notes,
        },
      };
      const { error: upErr } = await context.supabase
        .from("portfolios")
        .update({ risk_config: nextCfg })
        .eq("id", data.portfolio_id);
      if (upErr) throw new Error(upErr.message);
    }

    return summary;
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
      orders: result.decision.orders ?? [],
      executed: result.executed ?? [],
      asOf,
    };
  });

