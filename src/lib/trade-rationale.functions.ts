import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TradeRationale } from "./trade-rationale";

export type { TradeRationale };

export const getTradeRationale = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        symbol: z.string().min(1).max(32),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<TradeRationale | null> => {
    const { loadTradeRationale } = await import("./trade-rationale.server");
    return loadTradeRationale(context.supabase, data);
  });
