import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { CostBackfillSummary } from "@/lib/broker-cost-backfill";

/**
 * Pull the broker's booked charges onto trades already on the tape, so the
 * friction KPI reports invoiced money instead of modelled estimates.
 */
export const backfillBrokerChargesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid().optional(),
        lookbackDays: z.number().int().min(1).max(180).optional(),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }): Promise<CostBackfillSummary> => {
    const { backfillBrokerCosts } = await import("@/lib/broker-cost-backfill.server");
    return backfillBrokerCosts({
      db: context.supabase,
      userId: context.userId,
      ...(data.portfolioId ? { portfolioId: data.portfolioId } : {}),
      ...(data.lookbackDays ? { lookbackDays: data.lookbackDays } : {}),
    });
  });
