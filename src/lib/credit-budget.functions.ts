// Client-callable RPC surface for the credit-budget early warning.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface CreditBudgetVerdictDTO {
  enabled: boolean;
  probedAt: string;
  alertDate: string;
  mtdCalls: number;
  mtdCredits: number;
  last7dCalls: number;
  dailyBurnCredits: number;
  projectedMonthCredits: number;
  budgetCredits: number;
  pctMtd: number;
  pctProjection: number;
  alerts: Array<{ kind: string; remedy: string }>;
}

export interface CreditBudgetSettingsDTO {
  monthly_budget_credits: number;
  credits_per_ai_call: number;
  warn_pct_mtd: number;
  warn_pct_projection: number;
  enabled: boolean;
}

export const getCreditBudgetStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ verdict: CreditBudgetVerdictDTO; settings: CreditBudgetSettingsDTO }> => {
    const { evaluateCreditBudget, loadCreditBudgetSettings } = await import("@/lib/credit-budget.server");
    const [verdict, settings] = await Promise.all([
      evaluateCreditBudget(),
      loadCreditBudgetSettings(),
    ]);
    return { verdict, settings };
  });

const UpdateSchema = z.object({
  monthly_budget_credits: z.number().positive().max(1_000_000),
  credits_per_ai_call: z.number().positive().max(1000),
  warn_pct_mtd: z.number().min(1).max(100),
  warn_pct_projection: z.number().min(1).max(200),
  enabled: z.boolean(),
});

export const updateCreditBudgetSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => UpdateSchema.parse(data))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { supabase } = context;
    const { error } = await supabase
      .from("credit_budget_settings")
      .update({
        monthly_budget_credits: data.monthly_budget_credits,
        credits_per_ai_call: data.credits_per_ai_call,
        warn_pct_mtd: data.warn_pct_mtd,
        warn_pct_projection: data.warn_pct_projection,
        enabled: data.enabled,
      })
      .eq("id", true);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
