import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ValuationConsistencyResult } from "@/lib/valuation-consistency.server";

export const getValuationConsistency = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        jumpFactor: z.number().min(1.1).max(1000).optional(),
        lookbackDays: z.number().int().min(2).max(1000).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<ValuationConsistencyResult> => {
    const { runValuationConsistencyCheck } = await import(
      "@/lib/valuation-consistency.server"
    );
    return runValuationConsistencyCheck(context.supabase, data.portfolioId, {
      jumpFactor: data.jumpFactor,
      lookbackDays: data.lookbackDays,
    });
  });

export type { ValuationConsistencyResult };
