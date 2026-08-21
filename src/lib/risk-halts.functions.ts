// Server function exposing current portfolio halt status for the UI banner.
//
// Reads the latest equity snapshot for a live mark and reuses the pure
// evaluator so the UI's numbers match what the engine will act on.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { evaluateRiskHalts, loadEquityStats } from "./risk-halts.server";
import { requireAal2 } from "@/lib/_server/require-aal2";
import {
  clampOverrideHours,
  loadActiveRiskHaltOverride,
  MAX_OVERRIDE_HOURS,
} from "./risk-halt-override.server";
import { parseRiskConfig } from "./universe.server";
import { formatUk } from "./uk-time";

export const getPortfolioRiskHalts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: portfolio, error } = await supabase
      .from("portfolios")
      .select("id, starting_cash, current_cash, risk_config")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (error || !portfolio) throw new Error("Portfolio not found or access denied");

    const cfg = parseRiskConfig(portfolio.risk_config);

    // Equity must come from the same valuation the engine acts on. The old
    // cost-basis sum (qty x avg_cost, FX legs included as raw negatives)
    // could understate NAV by thousands and fabricate a halt in this banner
    // that the engine itself never saw.
    const asOf = formatUk(new Date(), { year: "numeric", month: "2-digit", day: "2-digit" })
      .split("/").reverse().join("-"); // dd/mm/yyyy → yyyy-mm-dd

    const { data: latestSnapshot } = await supabase
      .from("equity_snapshots")
      .select("total_value, snapshot_date")
      .eq("portfolio_id", data.portfolioId)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    let currentEquity = Number(latestSnapshot?.total_value) || 0;
    if (!(currentEquity > 0)) {
      const { data: holdings } = await supabase
        .from("holdings")
        .select("symbol, quantity, avg_cost")
        .eq("portfolio_id", data.portfolioId);
      const cash = Number(portfolio.current_cash) || 0;
      currentEquity =
        cash +
        (holdings ?? []).reduce((s, h) => s + Number(h.quantity) * Number(h.avg_cost), 0);
    }

    const stats = await loadEquityStats(supabase, data.portfolioId, asOf).catch(
      () => ({ priorCloseEquity: null, peakEquity: null, netExternalFlow: 0 }),
    );

    const status = evaluateRiskHalts({
      startingEquity: Number(portfolio.starting_cash) || currentEquity,
      currentEquity,
      priorCloseEquity: stats.priorCloseEquity,
      peakEquity: stats.peakEquity,
      thresholds: {
        max_position_pct: 0, // informational only on this surface
        max_daily_loss_pct: cfg.max_daily_loss_pct,
        max_drawdown_halt_pct: cfg.max_drawdown_halt_pct,
      },
    });

    const override = await loadActiveRiskHaltOverride(supabase, data.portfolioId);

    return {
      ...status,
      // Halts stay visible in the payload, but `any_halt` reflects what the
      // engine will actually do: an active override lets buys through.
      halted_by_rule: status.any_halt,
      any_halt: override ? false : status.any_halt,
      override: override
        ? {
            id: override.id,
            reason: override.reason,
            created_at: override.createdAt,
            expires_at: override.expiresAt,
          }
        : null,
    };
  });

/**
 * Trade through an active halt for a bounded window. Money-affecting, so it
 * carries the same second-factor gate as the trading server functions.
 */
export const clearRiskHalt = createServerFn({ method: "POST" })
  .middleware([requireAal2])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        hours: z.number().int().min(1).max(MAX_OVERRIDE_HOURS).optional(),
        reason: z.string().max(280).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: portfolio } = await supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (!portfolio) throw new Error("Portfolio not found or access denied");

    const hours = clampOverrideHours(data.hours);
    const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();

    const { data: row, error } = await supabase
      .from("risk_halt_overrides")
      .insert({
        portfolio_id: data.portfolioId,
        user_id: userId,
        reason: data.reason ?? null,
        expires_at: expiresAt,
      })
      .select("id, expires_at")
      .single();
    if (error) throw new Error(error.message);

    return { ok: true as const, id: row.id as string, expires_at: row.expires_at as string, hours };
  });

/** Re-arm the halt immediately by expiring any active override. */
export const reinstateRiskHalt = createServerFn({ method: "POST" })
  .middleware([requireAal2])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("risk_halt_overrides")
      .update({ expires_at: new Date().toISOString() })
      .eq("portfolio_id", data.portfolioId)
      .eq("user_id", userId)
      .gt("expires_at", new Date().toISOString());
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

