// Thin server-function wrapper for the AI chart read (SMA + RSI).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getTechnicalRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        symbol: z.string().min(1).max(24),
        days: z.number().int().min(7).max(1825).default(90),
        periods: z.array(z.union([z.literal(20), z.literal(50), z.literal(100), z.literal(200)]))
          .min(1)
          .max(4)
          .default([50, 200]),
        basis: z
          .union([z.literal(20), z.literal(50), z.literal(100), z.literal(200)])
          .nullable()
          .default(null),
        signalMode: z.union([z.literal("cross"), z.literal("touch")]).default("cross"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { buildSymbolHistory, computeTrendStrength, isChartableSymbol } = await import(
      "./market-symbol-history"
    );
    const { buildTechnicalBrief } = await import("./technical-read");
    const { interpretChart } = await import("./technical-read.server");

    if (!isChartableSymbol(data.symbol)) throw new Error(`Unknown market symbol: ${data.symbol}`);

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - (data.days + 320));

    const prices = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close")
      .eq("symbol", data.symbol)
      .gte("price_date", since.toISOString().slice(0, 10))
      .order("price_date", { ascending: true })
      .limit(4000);
    if (prices.error) throw new Error(prices.error.message);

    const history = buildSymbolHistory(
      data.symbol,
      (prices.data ?? []).map((r) => ({
        symbol: r.symbol as string,
        price_date: r.price_date as string,
        close: Number(r.close),
      })),
      data.days,
    );

    if (!history.points.length) throw new Error(`No cached history for ${data.symbol}`);

    const trend = computeTrendStrength(history.points, data.periods, data.basis);
    const brief = buildTechnicalBrief(history, data.periods, trend, data.signalMode);
    return interpretChart(brief);
  });
