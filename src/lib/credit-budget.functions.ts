// Client-callable RPC surface for the credit-budget early warning.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { UpdateSchema } from "./credit-budget.helpers";
import type { CreditBudgetVerdictDTO, CreditBudgetSettingsDTO } from "./credit-budget.helpers";
export type { CreditBudgetVerdictDTO, CreditBudgetSettingsDTO };

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
