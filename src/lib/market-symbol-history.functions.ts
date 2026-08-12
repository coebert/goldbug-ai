// Server function backing the Market pulse drill-down chart page.
// Thin wrapper: all runtime logic lives in "./market-symbol-history".

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getSymbolHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        symbol: z.string().min(1).max(24),
        days: z.number().int().min(7).max(1825).default(90),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { buildSymbolHistory, isChartableSymbol } = await import("./market-symbol-history");

    if (!isChartableSymbol(data.symbol)) throw new Error(`Unsupported symbol: ${data.symbol}`);

    // Pull an extra 300 calendar days so the 200-day average is populated
    // from the very first point in the visible window.
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - (data.days + 320));
    const sinceIso = since.toISOString().slice(0, 10);

    const { data: rows, error } = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close")
      .eq("symbol", data.symbol)
      .gte("price_date", sinceIso)
      .order("price_date", { ascending: true })
      .limit(4000);

    if (error) throw new Error(error.message);

    let priceRows = (rows ?? []).map((r) => ({
      symbol: r.symbol as string,
      price_date: r.price_date as string,
      close: Number(r.close),
    }));

    // Free-form tickers usually aren't in the shared cache yet. Pull them from
    // the daily price feed on demand (which also backfills the cache).
    if (priceRows.length < Math.min(30, data.days)) {
      try {
        const { getDailyCandles } = await import("./market-data.server");
        const candles = await getDailyCandles(data.symbol, Math.min(data.days + 320, 2000));
        if (candles.length > priceRows.length) {
          priceRows = candles.map((c) => ({
            symbol: data.symbol,
            price_date: c.date,
            close: Number(c.close),
          }));
        }
      } catch (err) {
        console.error("symbol-history: on-demand fetch failed", data.symbol, err);
      }
    }

    return buildSymbolHistory(
      data.symbol,
      (rows ?? []).map((r) => ({
        symbol: r.symbol as string,
        price_date: r.price_date as string,
        close: Number(r.close),
      })),
      data.days,
    );
  });
