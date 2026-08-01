import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { InstrumentCcyFixResult } from "@/lib/instrument-ccy-fix.server";

export const applyInstrumentCcyFixes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        dryRun: z.boolean().optional(),
        symbols: z.array(z.string().min(1).max(32)).max(200).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<InstrumentCcyFixResult> => {
    const { applyInstrumentCcyFixesForPortfolio } = await import(
      "@/lib/instrument-ccy-fix.server"
    );
    return applyInstrumentCcyFixesForPortfolio(context.supabase, data.portfolioId, {
      dryRun: data.dryRun,
      symbols: data.symbols,
    });
  });

export type { InstrumentCcyFixResult };
