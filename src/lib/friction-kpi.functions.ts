import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { FrictionReport } from "@/lib/friction-kpi.server";

/**
 * Realised friction as bps of NAV (trailing window) plus the before/after
 * cost-and-return attribution around the cost-governor cutover.
 */
export const getFrictionReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        currency: z.string().min(3).max(3).optional(),
        windowDays: z.number().int().min(1).max(365).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<FrictionReport> => {
    const { loadFrictionReport } = await import("@/lib/friction-kpi.server");
    return loadFrictionReport({
      db: context.supabase,
      portfolioId: data.portfolioId,
      baseCcy: data.currency ?? "GBP",
      windowDays: data.windowDays,
    });
  });
