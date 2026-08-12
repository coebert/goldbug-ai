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

    const { loadHistoryRows } = await import("./market-history-backfill.server");
    const priceRows = await loadHistoryRows(data.symbol, data.days);

    return buildSymbolHistory(data.symbol, priceRows, data.days);

  });
