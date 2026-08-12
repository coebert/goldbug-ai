import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { StudyResult } from "./insider-event-study.server";

/** Runs the director-dealing event study over MKS.L and comparable names. */
export const runInsiderStudy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        symbols: z.array(z.string().trim().min(1).max(16)).min(1).max(24).optional(),
        minValue: z.number().min(0).max(50_000_000).optional(),
        lookbackDays: z.number().int().min(180).max(2000).optional(),
        horizons: z.array(z.number().int().min(1).max(252)).min(1).max(8).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }): Promise<StudyResult> => {
    const { runInsiderEventStudy } = await import("./insider-event-study.server");
    return runInsiderEventStudy(data);
  });
