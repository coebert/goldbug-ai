import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { NudgeReplayResult } from "./insider-nudge-replay";

/** Replays the last 1-2 years with and without the bounded insider nudge. */
export const runNudgeReplayFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        symbols: z.array(z.string().trim().min(1).max(16)).min(1).max(24).optional(),
        lookbackDays: z.number().int().min(365).max(900).optional(),
        minValue: z.number().min(0).max(50_000_000).optional(),
        params: z
          .object({
            entryThreshold: z.number().min(0.1).max(0.95).optional(),
            maxPositions: z.number().int().min(1).max(20).optional(),
            activeDays: z.number().int().min(1).max(90).optional(),
            halfLifeDays: z.number().min(0.5).max(60).optional(),
            costBps: z.number().min(0).max(200).optional(),
            nudgeScale: z.number().min(0).max(4).optional(),
            riskLevel: z.number().int().min(1).max(5).optional(),
          })
          .optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }): Promise<NudgeReplayResult> => {
    const { runInsiderNudgeReplay } = await import("./insider-nudge-replay.server");
    return runInsiderNudgeReplay(data);
  });
