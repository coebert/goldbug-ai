// Client-callable planned-vs-actual trade reconciliation report.
//
// Joins the AI's planned orders (decisions), what was routed (live_orders),
// and what executed (live_fills) for the caller's portfolios, and explains
// every gap — with suitability/appropriateness refusals called out.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ReconReport } from "@/lib/trade-reconciliation";

export const getTradeReconciliationReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        portfolioId: z.string().uuid().optional(),
        days: z.number().int().min(1).max(90).optional(),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ context, data }): Promise<ReconReport> => {
    const { buildTradeReconciliationReport } = await import(
      "@/lib/trade-reconciliation.server"
    );
    return buildTradeReconciliationReport({
      db: context.supabase,
      userId: context.userId,
      portfolioId: data.portfolioId,
      days: data.days ?? 14,
    });
  });
