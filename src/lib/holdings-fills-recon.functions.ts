import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PortfolioReconReport } from "@/lib/holdings-fills-recon.server";

export type { PortfolioReconReport };

export const getHoldingsFillsRecon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        portfolioId: z.string().uuid().optional(),
        includeMatches: z.boolean().optional(),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ context, data }): Promise<PortfolioReconReport> => {
    const { buildHoldingsFillsReconReport } = await import("@/lib/holdings-fills-recon.server");
    return buildHoldingsFillsReconReport({
      db: context.supabase,
      userId: context.userId,
      portfolioId: data.portfolioId,
      includeMatches: data.includeMatches,
    });
  });
