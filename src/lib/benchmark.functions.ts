// Benchmark price-series server function. Split out of trading.functions.ts
// during Phase 3. The legacy "@/lib/trading.functions" barrel re-exports
// this for backwards compatibility.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getBenchmarkSeries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        symbol: z.string().min(1).max(12),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(i),
  )
  .handler(async ({ data }) => {
    const { getDailyCandlesRange } = await import("./market-data.server");
    try {
      const candles = await getDailyCandlesRange(data.symbol, data.from, data.to);
      return {
        symbol: data.symbol,
        series: candles.map((c) => ({ date: c.date, close: Number(c.close) })),
      };
    } catch (err) {
      return {
        symbol: data.symbol,
        series: [] as { date: string; close: number }[],
        error: err instanceof Error ? err.message : "failed",
      };
    }
  });
