import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const TrainInput = z.object({
  horizonDays: z.number().int().min(1).max(20).default(5),
  realMoneyOnly: z.boolean().default(false),
});

/** Rebuild the evidence brief and have the AI rewrite the account playbook. */
export const trainDecisionPlaybook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => TrainInput.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const { trainPlaybook } = await import("./decision-model/playbook.server");
    try {
      const stored = await trainPlaybook({
        userId: context.userId,
        horizonDays: data.horizonDays,
        realMoneyOnly: data.realMoneyOnly,
      });
      return { ok: true as const, stored };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

/** Read the current playbook, plus the evidence it was written from. */
export const getDecisionPlaybook = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadLatestPlaybook } = await import("./decision-model/playbook.server");
    const stored = await loadLatestPlaybook(context.userId);
    return { stored };
  });
