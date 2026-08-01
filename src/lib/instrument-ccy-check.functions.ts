import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { InstrumentCcyCheckResult } from "@/lib/instrument-ccy-check.server";

export const getInstrumentCcyCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        lookbackDays: z.number().int().min(1).max(365).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<InstrumentCcyCheckResult> => {
    const { runInstrumentCcyCheck } = await import("@/lib/instrument-ccy-check.server");
    return runInstrumentCcyCheck(context.supabase, data.portfolioId, {
      lookbackDays: data.lookbackDays,
    });
  });

export type { InstrumentCcyCheckResult };
