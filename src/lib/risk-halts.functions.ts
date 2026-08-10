// Server function exposing current portfolio halt status for the UI banner.
//
// Reads the latest equity snapshot for a live mark and reuses the pure
// evaluator so the UI's numbers match what the engine will act on.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { evaluateRiskHalts, loadEquityStats } from "./risk-halts.server";
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

    const { data: holdings } = await supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost")
      .eq("portfolio_id", data.portfolioId);
    const cash = Number(portfolio.current_cash) || 0;
    const holdingsValue = (holdings ?? []).reduce(
      (s, h) => s + Number(h.quantity) * Number(h.avg_cost),
      0,
    );
    const currentEquity = cash + holdingsValue;

    const asOf = formatUk(new Date(), { year: "numeric", month: "2-digit", day: "2-digit" })
      .split("/").reverse().join("-"); // dd/mm/yyyy → yyyy-mm-dd
    const stats = await loadEquityStats(supabase, data.portfolioId, asOf).catch(
      () => ({ priorCloseEquity: null, peakEquity: null, netExternalFlow: 0 }),
    );

    return evaluateRiskHalts({
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
  });
