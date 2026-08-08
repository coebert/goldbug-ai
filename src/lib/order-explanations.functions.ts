import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ExplainInputSchema,
  runExplainOrder,
  type ExplainOrderInput,
  type ExplainOrderOutput,
} from "./order-explanations.server";

export type { ExplainOrderInput, ExplainOrderOutput };

export const explainDecisionOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ExplainInputSchema.parse(input))
  .handler(async ({ data, context }) => runExplainOrder(data, context.supabase));

export const getOrderExplanationBackfillStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid().optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { getBackfillStatus } = await import("./order-explanations-backfill.server");
    return getBackfillStatus(context.supabase, data.portfolioId);
  });

export const backfillOrderExplanations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid().optional(),
        batchSize: z.number().int().min(1).max(25).default(10),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { runBackfillBatch } = await import("./order-explanations-backfill.server");
    return runBackfillBatch(context.supabase, {
      portfolioId: data.portfolioId,
      batchSize: data.batchSize,
    });
  });

