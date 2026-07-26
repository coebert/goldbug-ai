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

// Cost model must match the backtest runner (10bps fee + 10bps slippage/side).
const FEE_BPS_PER_SIDE = 0.001;
const SLIPPAGE_BPS_PER_SIDE = 0.001;

export type HedgeReportPoint = {
  date: string;                 // ISO
  advisedNotional: number;      // decision.targetNotional
  observedNotional: number;     // reconciliation.observed.notional (may be 0)
  action: TailHedgeDecision["action"];
  applied: boolean;
  deferralReason: string | null;
};

export type HedgeReportTrade = {
  date: string;
  action: "buy" | "sell";
  symbol: string | null;
  qty: number;
  notional: number;            // absolute
  estFee: number;              // notional * FEE_BPS_PER_SIDE
  estSlippage: number;         // notional * SLIPPAGE_BPS_PER_SIDE
  slippageVsAdvised: number;   // reconciliation.slippage.notionalDiff
  reason: string;
};

export type HedgeReportTotals = {
  decisions: number;
  applied: number;
  deferred: number;
  buyCount: number;
  sellCount: number;
  grossNotional: number;       // Σ |applied.notional|
  netNotional: number;         // Σ signed applied notional (buy +, sell −)
  estFees: number;
  estSlippage: number;
  unfilledAdvisedNotional: number; // Σ slippage.notionalDiff where unfilled/partial
  deferralBreakdown: Record<string, number>;
};

export type PhaseAttributionRow = {
  phase: string;               // e.g. "phase6_tail_hedge"
  cagrDelta: number;
  ddDelta: number;
  winRateDelta: number;
};

export type HedgeReport = {
  portfolioId: string;
  from: string | null;
  to: string | null;
  series: HedgeReportPoint[];
  trades: HedgeReportTrade[];
  totals: HedgeReportTotals;
  phaseAttribution: PhaseAttributionRow[]; // empty if none persisted
};

type DecisionRow = {
  created_at: string;
  raw: unknown;
};

type RawShape = {
  tail_hedge?: TailHedgeDecision | null;
  tail_hedge_execution?: {
    applied: boolean; reason: string; symbol: string | null; qty: number; notional: number;
  } | null;
  tail_hedge_reconciliation?: TailHedgeReconciliation | null;
  phase_attribution?: Record<string, { cagrDelta: number; ddDelta: number; winRateDelta: number }> | null;
};

export function buildHedgeReport(
  portfolioId: string,
  rows: DecisionRow[],
): HedgeReport {
  const series: HedgeReportPoint[] = [];
  const trades: HedgeReportTrade[] = [];
  const deferralBreakdown: Record<string, number> = {};
  let grossNotional = 0;
  let netNotional = 0;
  let estFees = 0;
  let estSlippage = 0;
  let unfilledAdvisedNotional = 0;
  let appliedCount = 0;
  let deferredCount = 0;
  let buyCount = 0;
  let sellCount = 0;
  let phaseAttribution: PhaseAttributionRow[] = [];

  for (const row of rows) {
    const raw = (row.raw ?? {}) as RawShape;
    const dec = raw.tail_hedge ?? null;
    if (!dec) continue;

    const exec = raw.tail_hedge_execution ?? null;
    const rec = raw.tail_hedge_reconciliation ?? null;

    series.push({
      date: row.created_at,
      advisedNotional: Number(dec.targetNotional) || 0,
      observedNotional: Number(rec?.observed?.notional ?? 0) || 0,
      action: dec.action,
      applied: Boolean(exec?.applied),
      deferralReason: rec?.deferralReason ?? null,
    });

    if (exec?.applied && (dec.action === "buy" || dec.action === "sell")) {
      const notional = Math.abs(Number(exec.notional) || 0);
      const fee = notional * FEE_BPS_PER_SIDE;
      const slip = notional * SLIPPAGE_BPS_PER_SIDE;
      grossNotional += notional;
      netNotional += dec.action === "buy" ? notional : -notional;
      estFees += fee;
      estSlippage += slip;
      appliedCount += 1;
      if (dec.action === "buy") buyCount += 1; else sellCount += 1;
      trades.push({
        date: row.created_at,
        action: dec.action,
        symbol: exec.symbol,
        qty: Number(exec.qty) || 0,
        notional,
        estFee: fee,
        estSlippage: slip,
        slippageVsAdvised: Number(rec?.slippage?.notionalDiff ?? 0) || 0,
        reason: exec.reason ?? "",
      });
    } else {
      const reason = rec?.deferralReason ?? "unknown";
      deferralBreakdown[reason] = (deferralBreakdown[reason] ?? 0) + 1;
      if (rec?.slippage && (rec.slippage.kind === "unfilled" || rec.slippage.kind === "partial")) {
        unfilledAdvisedNotional += Math.max(0, Number(rec.slippage.notionalDiff) || 0);
      }
      if (dec.action !== "hold") deferredCount += 1;
    }

    // Take the most recent phase_attribution snapshot.
    if (raw.phase_attribution) {
      phaseAttribution = Object.entries(raw.phase_attribution).map(([phase, v]) => ({
        phase,
        cagrDelta: Number(v.cagrDelta) || 0,
        ddDelta: Number(v.ddDelta) || 0,
        winRateDelta: Number(v.winRateDelta) || 0,
      }));
    }
  }

  return {
    portfolioId,
    from: series.length ? series[0].date : null,
    to: series.length ? series[series.length - 1].date : null,
    series,
    trades,
    totals: {
      decisions: series.length,
      applied: appliedCount,
      deferred: deferredCount,
      buyCount,
      sellCount,
      grossNotional,
      netNotional,
      estFees,
      estSlippage,
      unfilledAdvisedNotional,
      deferralBreakdown,
    },
    phaseAttribution,
  };
}

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
