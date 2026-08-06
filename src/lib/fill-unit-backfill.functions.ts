import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { FillUnitBackfillResult } from "./fill-unit-backfill.server";

const Input = z.object({
  portfolioId: z.string().uuid().optional(),
  /** Defaults to true: nothing is rewritten unless explicitly asked. */
  dryRun: z.boolean().optional(),
});

export const backfillFillUnits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => Input.parse(v ?? {}))
  .handler(async ({ data, context }): Promise<FillUnitBackfillResult> => {
    const { runFillUnitBackfill } = await import("./fill-unit-backfill.server");
    return runFillUnitBackfill({
      db: context.supabase,
      userId: context.userId,
      ...(data.portfolioId ? { portfolioId: data.portfolioId } : {}),
      dryRun: data.dryRun !== false,
    });
  });

export type { FillUnitBackfillResult };
