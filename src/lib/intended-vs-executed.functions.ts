// Metrics: intended-vs-executed trade rates per portfolio and per symbol.
// Derived from ai_decision_audit rows over a configurable lookback window.
//
// Intended  = action IN ('buy','sell')
// Executed  = outcome IN ('placed','filled','partial')      — reached broker
// Filled    = outcome IN ('filled','partial')               — actually traded
// Missed    = intended AND outcome IN ('rejected','skipped','cancelled','error')
//
// A near-zero executed_rate for a portfolio (or a chronic per-symbol miss)
// is the same class of regression as the "empty live_orders for two cycles"
// alert — surfaced here as a live UI + used by the per-symbol alerter.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

import { EXECUTED, FILLED, MISSED, computeIntendedVsExecuted } from "./intended-vs-executed.helpers";
import type { SymbolFillMetric, IntendedVsExecutedMetrics, AuditRow } from "./intended-vs-executed.helpers";
export { computeIntendedVsExecuted };
export type { SymbolFillMetric, IntendedVsExecutedMetrics };

export const getIntendedVsExecutedMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        windowHours: z.number().int().min(1).max(24 * 30).default(72),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<IntendedVsExecutedMetrics> => {
    const since = new Date(Date.now() - data.windowHours * 3600_000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("ai_decision_audit")
      .select("symbol, action, outcome, outcome_detail")
      .eq("portfolio_id", data.portfolioId)
      .gte("decided_at", since)
      .limit(10_000);
    if (error) throw new Error(error.message);
    return computeIntendedVsExecuted(
      (rows ?? []) as AuditRow[],
      data.portfolioId,
      data.windowHours,
      since,
    );
  });
