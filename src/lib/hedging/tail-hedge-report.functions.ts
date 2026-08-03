// Phase 6 — Tail hedge report.
//
// Rolls up every decision row for a portfolio and extracts the persisted
// `tail_hedge`, `tail_hedge_execution`, and `tail_hedge_reconciliation`
// blocks. Produces:
//   - a time-series of advisory vs executed notional (for charts),
//   - discrete hedge trades (buys/sells with fees & slippage),
//   - aggregate fees, slippage, cumulative net notional,
//   - phase-attribution rollup pulled from the same decision row when the
//     paper-trading engine wrote a `phase_attribution` block, so the caller
//     can see Phase 6's contribution alongside Phases 2–5.
//
// Pure aggregation — no external calls beyond the initial decisions read.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TailHedgeDecision } from "./tail-hedge";
import type { TailHedgeReconciliation } from "./tail-hedge-reconcile";

import { FEE_BPS_PER_SIDE, SLIPPAGE_BPS_PER_SIDE, buildHedgeReport } from "./tail-hedge-report.helpers";
import type { HedgeReportPoint, HedgeReportTrade, HedgeReportTotals, PhaseAttributionRow, HedgeReport, DecisionRow, RawShape } from "./tail-hedge-report.helpers";
export { buildHedgeReport };
export type { HedgeReportPoint, HedgeReportTrade, HedgeReportTotals, PhaseAttributionRow, HedgeReport };

export const getTailHedgeReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      sinceDays: z.number().int().min(1).max(365).optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }): Promise<HedgeReport> => {
    const { supabase } = context;
    const sinceIso = data.sinceDays
      ? new Date(Date.now() - data.sinceDays * 24 * 3600 * 1000).toISOString()
      : null;

    let q = supabase
      .from("decisions")
      .select("created_at, raw")
      .eq("portfolio_id", data.portfolioId)
      .order("created_at", { ascending: true })
      .limit(1000);
    if (sinceIso) q = q.gte("created_at", sinceIso);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return buildHedgeReport(data.portfolioId, (rows ?? []) as DecisionRow[]);
  });
