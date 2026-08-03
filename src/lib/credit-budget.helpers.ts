// Runtime helpers extracted from credit-budget.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

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

export const UpdateSchema = z.object({
  monthly_budget_credits: z.number().positive().max(1_000_000),
  credits_per_ai_call: z.number().positive().max(1000),
  warn_pct_mtd: z.number().min(1).max(100),
  warn_pct_projection: z.number().min(1).max(200),
  enabled: z.boolean(),
});
