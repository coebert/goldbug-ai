// Credit-budget early warning engine.
//
// The deployed Worker has no runtime API to query Lovable's authoritative
// workspace credit balance. As a supplement we estimate spend from our own
// ai_decision_audit trail (one row ≈ one AI gateway call), convert to
// credits via a configurable per-call cost, project month-end consumption
// from a rolling 7-day burn rate, and push a warning if MTD or projection
// crosses configured thresholds. Lovable → Settings → Plans & credits is
// still authoritative; this exists so operators are warned days before
// trading is blocked, not hours after.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface CreditBudgetSettings {
  monthly_budget_credits: number;
  credits_per_ai_call: number;
  warn_pct_mtd: number;
  warn_pct_projection: number;
  enabled: boolean;
}

export interface CreditBudgetVerdict {
  enabled: boolean;
  probedAt: string;              // ISO timestamp
  alertDate: string;             // UK-local YYYY-MM-DD
  mtdCalls: number;
  mtdCredits: number;
  last7dCalls: number;
  dailyBurnCredits: number;      // 7-day avg credits/day
  projectedMonthCredits: number; // MTD + burn × days remaining
  budgetCredits: number;
  pctMtd: number;                // (mtdCredits / budget) × 100
  pctProjection: number;         // (projectedMonthCredits / budget) × 100
  alerts: Array<{
    kind: "mtd_over_threshold" | "projection_over_threshold";
    remedy: string;
  }>;
}

/** Europe/London YYYY-MM-DD (handles GMT/BST automatically). */
function ukDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Start of the UK-local month for a given instant, returned as ISO UTC. */
function ukMonthStartIso(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  // Midnight UK-local on the 1st is 00:00 UTC in winter and 23:00 prev-day UTC
  // in summer; using YYYY-MM-01T00:00:00Z under-counts by at most one hour in
  // BST, which is well within the burn-rate estimator's uncertainty.
  return `${y}-${m}-01T00:00:00Z`;
}

/** Days in the UK-local month for `now`, and 1-based day-of-month. */
function ukMonthContext(now: Date): { day: number; daysInMonth: number } {
  const [y, m, d] = ukDate(now).split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { day: d, daysInMonth };
}

export async function loadCreditBudgetSettings(): Promise<CreditBudgetSettings> {
  const { data } = await supabaseAdmin
    .from("credit_budget_settings")
    .select("monthly_budget_credits, credits_per_ai_call, warn_pct_mtd, warn_pct_projection, enabled")
    .eq("id", true)
    .maybeSingle();
  return {
    monthly_budget_credits: Number(data?.monthly_budget_credits ?? 500),
    credits_per_ai_call: Number(data?.credits_per_ai_call ?? 0.15),
    warn_pct_mtd: Number(data?.warn_pct_mtd ?? 70),
    warn_pct_projection: Number(data?.warn_pct_projection ?? 90),
    enabled: data?.enabled ?? true,
  };
}

/** Count ai_decision_audit rows in [sinceIso, now]. Each row ≈ 1 AI call. */
async function countAiCallsSince(sinceIso: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("ai_decision_audit")
    .select("id", { count: "exact", head: true })
    .eq("source", "ai_decision")
    .gte("decided_at", sinceIso);
  if (error) throw new Error(`ai_decision_audit count failed: ${error.message}`);
  return count ?? 0;
}

export async function evaluateCreditBudget(now: Date = new Date()): Promise<CreditBudgetVerdict> {
  const settings = await loadCreditBudgetSettings();
  const alertDate = ukDate(now);
  const monthStartIso = ukMonthStartIso(now);
  const sevenDaysAgoIso = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

  const [mtdCalls, last7dCalls] = await Promise.all([
    countAiCallsSince(monthStartIso),
    countAiCallsSince(sevenDaysAgoIso),
  ]);

  const mtdCredits = mtdCalls * settings.credits_per_ai_call;
  const dailyBurnCredits = (last7dCalls / 7) * settings.credits_per_ai_call;
  const { day, daysInMonth } = ukMonthContext(now);
  const daysRemaining = Math.max(0, daysInMonth - day);
  const projectedMonthCredits = mtdCredits + dailyBurnCredits * daysRemaining;
  const budgetCredits = settings.monthly_budget_credits;
  const pctMtd = (mtdCredits / budgetCredits) * 100;
  const pctProjection = (projectedMonthCredits / budgetCredits) * 100;

  const alerts: CreditBudgetVerdict["alerts"] = [];
  if (settings.enabled && pctMtd >= settings.warn_pct_mtd) {
    alerts.push({
      kind: "mtd_over_threshold",
      remedy: `Month-to-date estimated spend is ${pctMtd.toFixed(0)}% of your ${budgetCredits}-credit budget (~${mtdCredits.toFixed(1)} credits). Add credits in Lovable → Settings → Plans & credits, or raise the workspace member cap, to avoid a mid-week trading block.`,
    });
  }
  if (settings.enabled && pctProjection >= settings.warn_pct_projection) {
    alerts.push({
      kind: "projection_over_threshold",
      remedy: `At the current 7-day burn (~${dailyBurnCredits.toFixed(1)} credits/day) projected month-end spend is ${pctProjection.toFixed(0)}% of your ${budgetCredits}-credit budget. Top up before trading is blocked.`,
    });
  }

  return {
    enabled: settings.enabled,
    probedAt: now.toISOString(),
    alertDate,
    mtdCalls,
    mtdCredits,
    last7dCalls,
    dailyBurnCredits,
    projectedMonthCredits,
    budgetCredits,
    pctMtd,
    pctProjection,
    alerts,
  };
}
