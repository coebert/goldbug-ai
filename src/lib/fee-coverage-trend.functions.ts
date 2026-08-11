import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { CoverageTrend } from "@/lib/fee-coverage-trend";

/**
 * Trailing-window broker-charge coverage per portfolio plus an overall line.
 */
export const getCoverageTrend = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        days: z.number().int().min(7).max(180).optional(),
        windowDays: z.number().int().min(1).max(60).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<CoverageTrend> => {
    const { loadCoverageTrend } = await import("@/lib/fee-coverage-trend.server");
    return loadCoverageTrend({
      db: context.supabase,
      days: data.days,
      windowDays: data.windowDays,
    });
  });
