// Authenticated entry points for the daily model-vs-rules comparison and for
// rebuilding per-symbol historical signal strength.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DailyComparison } from "./daily-comparison.server";

export type { DailyComparison, ComparisonRow } from "./daily-comparison.server";

export const getDailyComparison = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ portfolioId: z.string().uuid(), horizonDays: z.number().int().min(1).max(60).optional() }).parse(data),
  )
  .handler(async ({ data, context }): Promise<DailyComparison> => {
    const { buildDailyComparison } = await import("./daily-comparison.server");
    return buildDailyComparison({
      userId: context.userId,
      portfolioId: data.portfolioId,
      ...(data.horizonDays == null ? {} : { horizonDays: data.horizonDays }),
    });
  });

export const refreshSymbolStrengths = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        horizonDays: z.number().int().min(1).max(60).optional(),
        realMoneyOnly: z.boolean().optional(),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { computeAndStoreSymbolStrengths } = await import(
      "./decision-model/symbol-strength.server"
    );
    const res = await computeAndStoreSymbolStrengths({
      userId: context.userId,
      ...(data.horizonDays == null ? {} : { horizonDays: data.horizonDays }),
      ...(data.realMoneyOnly == null ? {} : { realMoneyOnly: data.realMoneyOnly }),
    });
    return {
      ok: res.ok,
      ...(res.error ? { error: res.error } : {}),
      measured: res.rows.length,
      from: res.from,
      to: res.to,
      modelScored: res.modelScored,
    };
  });
