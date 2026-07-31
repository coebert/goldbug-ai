import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PriceUnitAuditResult } from "@/lib/price-unit-audit.server";

export const getPriceUnitAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<PriceUnitAuditResult> => {
    const { buildPriceUnitAudit } = await import("@/lib/price-unit-audit.server");
    const date = data.date ?? new Date().toISOString().slice(0, 10);
    return buildPriceUnitAudit(context.supabase, data.portfolioId, date);
  });

export type { PriceUnitAuditResult };
