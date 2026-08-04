import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { RevalueRunResult } from "@/lib/equity-snapshot-revalue.server";

export const revalueSnapshotHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        dryRun: z.boolean().optional(),
        // Reconstruct days that have no stored snapshot at all, so a gap in
        // the ledger doesn't leave a straight line across the chart.
        fillGaps: z.boolean().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<RevalueRunResult> => {
    const { revalueHistoricalSnapshots } = await import(
      "@/lib/equity-snapshot-revalue.server"
    );
    return revalueHistoricalSnapshots(context.supabase, data.portfolioId, {
      dryRun: data.dryRun,
      fillGaps: data.fillGaps,
    });
  });

export type { RevalueRunResult };
