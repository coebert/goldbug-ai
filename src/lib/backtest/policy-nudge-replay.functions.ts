import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PolicyNudgeReplayResult } from "./policy-nudge-replay";
import type { PolicySweepResult } from "./policy-nudge-sweep";

/** Replays the tape with and without the bounded policy-maker nudge. */
export const runPolicyNudgeReplayFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        symbols: z.array(z.string().trim().min(1).max(16)).min(1).max(24).optional(),
        lookbackDays: z.number().int().min(365).max(900).optional(),
        params: z
          .object({
            entryThreshold: z.number().min(0.1).max(0.95).optional(),
            maxPositions: z.number().int().min(1).max(20).optional(),
            halfLifeHours: z.number().min(2).max(336).optional(),
            costBps: z.number().min(0).max(200).optional(),
            nudgeScale: z.number().min(0).max(4).optional(),
            riskLevel: z.number().int().min(1).max(5).optional(),
          })
          .optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<PolicyNudgeReplayResult> => {
    const { runPolicyReplay } = await import("./policy-nudge-replay.server");
    return runPolicyReplay(context.supabase, data);
  });

/** Sensitivity grid: nudge strength × regime-scaling gain, on one tape load. */
export const runPolicyNudgeSweepFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        symbols: z.array(z.string().trim().min(1).max(16)).min(1).max(24).optional(),
        lookbackDays: z.number().int().min(365).max(900).optional(),
        nudgeScales: z.array(z.number().min(0).max(4)).min(1).max(6).optional(),
        regimeGains: z.array(z.number().min(0).max(4)).min(1).max(6).optional(),
        params: z
          .object({
            entryThreshold: z.number().min(0.1).max(0.95).optional(),
            maxPositions: z.number().int().min(1).max(20).optional(),
            halfLifeHours: z.number().min(2).max(336).optional(),
            costBps: z.number().min(0).max(200).optional(),
            riskLevel: z.number().int().min(1).max(5).optional(),
          })
          .optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<PolicySweepResult> => {
    const { runPolicySweep } = await import("./policy-nudge-replay.server");
    return runPolicySweep(context.supabase, data);
  });
