// Thin server-function wrapper (see tanstack-serverfn-splitting): all runtime
// logic lives in valuation-freshness.server.ts.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ValuationFreshness } from "@/lib/valuation-freshness.server";

export const getLastValuationRefresh = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }): Promise<ValuationFreshness> => {
    const { getValuationFreshness } = await import("@/lib/valuation-freshness.server");
    return getValuationFreshness(context.supabase, data.portfolioId);
  });
