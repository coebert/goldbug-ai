// Server function wrapping the crypto playbook replay backtest.
// Fetches historical bars for the six approved ETPs and runs the pure
// engine at the portfolio's risk level.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const runCryptoBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        years: z.number().int().min(1).max(10).default(3),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: p, error } = await context.supabase
      .from("portfolios")
      .select("id, starting_cash, risk_level")
      .eq("id", data.portfolio_id)
      .single();
    if (error || !p) throw new Error("Portfolio not found");

    const { getDailyCandlesRange } = await import("./market-data.server");
    const {
      runCryptoPlaybookBacktest,
      CRYPTO_BACKTEST_SYMBOLS,
    } = await import("./crypto-backtest.server");

    const to = new Date();
    to.setUTCHours(0, 0, 0, 0);
    const from = new Date(to);
    from.setUTCFullYear(from.getUTCFullYear() - data.years);
    // Warm-up so day 1 has SMA200 available.
    const warm = new Date(from);
    warm.setUTCDate(warm.getUTCDate() - 260);
    const fromISO = from.toISOString().slice(0, 10);
    const toISO = to.toISOString().slice(0, 10);
    const warmISO = warm.toISOString().slice(0, 10);

    const symbols = await Promise.all(
      CRYPTO_BACKTEST_SYMBOLS.map(async (s) => ({
        symbol: s.symbol,
        group: s.group,
        candles: await getDailyCandlesRange(s.symbol, warmISO, toISO),
      })),
    );

    const report = runCryptoPlaybookBacktest({
      from: fromISO,
      to: toISO,
      startingCash: Number(p.starting_cash),
      riskLevel: (p.risk_level ?? "balanced") as "conservative" | "balanced" | "aggressive",
      symbols,
    });

    return {
      ok: true as const,
      risk_level: p.risk_level,
      report,
      symbolCoverage: symbols.map((s) => ({ symbol: s.symbol, bars: s.candles.length })),
    };
  });
