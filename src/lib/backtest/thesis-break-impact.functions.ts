import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ThesisImpactResult } from "./thesis-break-impact.server";

/** Replays the tape with the thesis-break exit layer off and on. */
export const runThesisBreakImpactFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        symbols: z.array(z.string().trim().min(1).max(16)).min(1).max(16).optional(),
        lookbackDays: z.number().int().min(180).max(900).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<ThesisImpactResult> => {
    const { runThesisBreakImpact } = await import("./thesis-break-impact.server");
    return runThesisBreakImpact(context.supabase, data);
  });
