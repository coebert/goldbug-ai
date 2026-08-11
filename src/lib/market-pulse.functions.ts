// Server function backing the home-screen "Market pulse" dashboard.
// Thin wrapper: all runtime logic lives in "./market-pulse".

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getMarketPulse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ comparisonDays: z.number().int().min(30).max(365).default(90) })
      .default({ comparisonDays: 90 })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { PULSE_SYMBOLS, computeMarketPulse } = await import("./market-pulse");

    // 400 sessions covers the 3-month lookback plus the 50-day average with
    // room for holidays; the row cap keeps the payload small.
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 420);
    const sinceIso = since.toISOString().slice(0, 10);

    const { data: rows, error } = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close")
      .in("symbol", PULSE_SYMBOLS)
      .gte("price_date", sinceIso)
      .order("price_date", { ascending: true })
      .limit(20000);

    if (error) throw new Error(error.message);

    return computeMarketPulse(
      (rows ?? []).map((r) => ({
        symbol: r.symbol as string,
        price_date: r.price_date as string,
        close: Number(r.close),
      })),
      data.comparisonDays,
    );
  });
