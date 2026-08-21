// Client-callable reconciliation outcome metrics.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ReconMetricsSummary } from "@/lib/recon-metrics";

export const getReconMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        portfolioId: z.string().uuid().optional(),
        windowDays: z.number().int().min(1).max(90).optional(),
        bucketHours: z.number().int().min(1).max(168).optional(),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ context, data }): Promise<ReconMetricsSummary> => {
    const { buildReconMetrics } = await import("@/lib/recon-metrics.server");
    return buildReconMetrics({
      db: context.supabase,
      userId: context.userId,
      portfolioId: data.portfolioId,
      windowDays: data.windowDays ?? 14,
      ...(data.bucketHours != null ? { bucketHours: data.bucketHours } : {}),
    });
  });
