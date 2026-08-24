import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ZeroFeeResyncResult } from "@/lib/zero-fee-resync.server";

/**
 * Admin action: re-pull broker charges for fills still sitting at zero fee and
 * report exactly which rows changed.
 */
export const resyncZeroFeeFillsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid().optional(),
        lookbackDays: z.number().int().min(1).max(180).optional(),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }): Promise<ZeroFeeResyncResult> => {
    const { resyncZeroFeeFills } = await import("@/lib/zero-fee-resync.server");
    return resyncZeroFeeFills({
      db: context.supabase,
      userId: context.userId,
      ...(data.portfolioId ? { portfolioId: data.portfolioId } : {}),
      ...(data.lookbackDays ? { lookbackDays: data.lookbackDays } : {}),
    });
  });
