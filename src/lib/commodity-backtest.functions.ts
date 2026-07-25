// Server function wrapping the commodity rejection backtest engine.
// Loads the portfolio's risk config, fetches historical daily bars for the
// five commodity replay symbols, and runs the pure engine.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const runCommodityBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        // Number of years of history to replay. 1–10.
        years: z.number().int().min(1).max(10).default(3),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: p, error } = await context.supabase
      .from("portfolios")
      .select("id, starting_cash, risk_level, risk_config")
      .eq("id", data.portfolio_id)
      .single();
    if (error || !p) throw new Error("Portfolio not found");

    const { parseRiskConfig } = await import("./universe.server");
    const { getDailyCandlesRange } = await import("./market-data.server");
    const {
      runCommodityRejectionBacktest,
      COMMODITY_BACKTEST_SYMBOLS,
    } = await import("./commodity-backtest.server");

    const to = new Date();
    to.setUTCHours(0, 0, 0, 0);
    const from = new Date(to);
    from.setUTCFullYear(from.getUTCFullYear() - data.years);
    // Warm-up so the first "from" day already has SMA50 available.
    const warm = new Date(from);
    warm.setUTCDate(warm.getUTCDate() - 120);
    const fromISO = from.toISOString().slice(0, 10);
    const toISO = to.toISOString().slice(0, 10);
    const warmISO = warm.toISOString().slice(0, 10);

    const symbols = await Promise.all(
      COMMODITY_BACKTEST_SYMBOLS.map(async (s) => ({
        symbol: s.symbol,
        group: s.group,
        candles: await getDailyCandlesRange(s.symbol, warmISO, toISO),
      })),
    );

    const report = runCommodityRejectionBacktest({
      from: fromISO,
      to: toISO,
      startingCash: Number(p.starting_cash),
      riskLevel: (p.risk_level ?? "balanced") as "conservative" | "balanced" | "aggressive",
      riskConfig: parseRiskConfig(p.risk_config),
      symbols,
    });

    return {
      ok: true as const,
      risk_level: p.risk_level,
      report,
      symbolCoverage: symbols.map((s) => ({ symbol: s.symbol, bars: s.candles.length })),
    };
  });
