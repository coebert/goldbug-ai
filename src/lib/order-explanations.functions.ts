import { createServerFn } from "@tanstack/react-start";

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
