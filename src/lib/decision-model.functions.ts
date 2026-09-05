import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const FitInput = z.object({
  horizonDays: z.number().int().min(1).max(20).default(5),
  realMoneyOnly: z.boolean().default(false),
});

/** Refit the decision model on the account's full recorded history. */
export const fitDecisionModel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => FitInput.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const { fitAndStoreModel } = await import("./decision-model/model.server");
    try {
      const model = await fitAndStoreModel({
        userId: context.userId,
        horizonDays: data.horizonDays,
        realMoneyOnly: data.realMoneyOnly,
      });
      return { ok: true as const, model };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

/** Read the most recently fitted model, with its feature labels for display. */
export const getDecisionModel = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadLatestModel } = await import("./decision-model/model.server");
    const { labelOf, bucketOf } = await import("./decision-model/features");
    const model = await loadLatestModel(context.userId);
    if (!model) return { model: null as null, features: [] as Array<never> };
    const features = model.feature_keys.map((key, i) => ({
      key,
      label: labelOf(key),
      bucket: bucketOf(key),
      coefficient: model.coefficients[i] ?? 0,
    }));
    return { model, features };
  });
