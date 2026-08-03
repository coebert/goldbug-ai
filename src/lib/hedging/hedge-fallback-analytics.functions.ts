// Client-callable RPC for the hedge instrument-fallback dashboard.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { HedgeFallbackSummary } from "@/lib/hedging/hedge-fallback-analytics";

export const getHedgeFallbackReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        days: z.number().int().min(1).max(365).optional(),
        portfolioId: z.string().uuid().optional(),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ context, data }): Promise<HedgeFallbackSummary> => {
    const { buildHedgeFallbackReport } = await import(
      "@/lib/hedging/hedge-fallback-analytics.server"
    );
    return buildHedgeFallbackReport({
      db: context.supabase,
      userId: context.userId,
      portfolioId: data.portfolioId,
      days: data.days ?? 90,
    });
  });
