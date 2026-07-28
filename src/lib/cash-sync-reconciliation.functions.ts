// Server function backing the Cash-Sync Reconciliation dashboard card.
//
// Returns the most recent CASH_SYNC broker-log rows for every live-mode
// portfolio owned by the caller, projecting only the fields the card
// needs: the cash delta, the broker's reported TotalValue, whether
// starting_cash was adjusted, and the gate reason recorded by
// live-cash-sync.server.ts. This is the diagnostic surface for the
// "was this drift booked as a deposit, and if not, why?" question.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type CashSyncReconRow = {
  id: string;
  portfolio_id: string;
  portfolio_name: string;
  created_at: string;
  currency: string | null;
  broker_cash: number | null;
  broker_total_value: number | null;
  delta: number | null;
  previous_cash: number | null;
  new_starting: number | null;
  previous_starting: number | null;
  starting_cash_adjusted: boolean;
  deposit_gate_reason: string | null;
  status: number | null;
  error: string | null;
};

export type CashSyncReconResponse = {
  rows: CashSyncReconRow[];
  totals: {
    total: number;
    adjusted: number;
    blocked: number;
    noDrift: number;
  };
};

export const getCashSyncReconciliation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ limit: z.number().int().min(1).max(200).default(50) })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<CashSyncReconResponse> => {
    const { data: portfolios, error: pErr } = await context.supabase
      .from("portfolios")
      .select("id, name, mode")
      .in("mode", ["live_prod", "live_sim"]);
    if (pErr) throw new Error(pErr.message);
    const portfolioNameById = new Map<string, string>();
    for (const p of portfolios ?? []) portfolioNameById.set(p.id, p.name);
    const ids = [...portfolioNameById.keys()];
    if (ids.length === 0) {
      return { rows: [], totals: { total: 0, adjusted: 0, blocked: 0, noDrift: 0 } };
    }

    const { data: logs, error } = await context.supabase
      .from("live_broker_log")
      .select("id, portfolio_id, created_at, status, error, request, response")
      .in("portfolio_id", ids)
      .eq("method", "CASH_SYNC")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);

    const rows: CashSyncReconRow[] = (logs ?? []).map((r) => {
      const resp = (r.response ?? {}) as Record<string, unknown>;
      const req = (r.request ?? {}) as Record<string, unknown>;
      const toNum = (v: unknown) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const adjusted = resp.startingCashAdjusted === true;
      return {
        id: r.id,
        portfolio_id: r.portfolio_id ?? "",
        portfolio_name: portfolioNameById.get(r.portfolio_id ?? "") ?? "—",
        created_at: r.created_at,
        currency: typeof resp.currency === "string" ? resp.currency : null,
        broker_cash: toNum(resp.brokerCash),
        broker_total_value: toNum(resp.brokerTotalValue),
        delta: toNum(resp.delta),
        previous_cash: toNum(req.previousCash),
        new_starting: toNum(resp.newStarting),
        previous_starting: toNum(resp.previousStarting ?? req.previousStarting),
        starting_cash_adjusted: adjusted,
        deposit_gate_reason:
          typeof resp.depositGateReason === "string" ? resp.depositGateReason : null,
        status: r.status ?? null,
        error: r.error ?? null,
      };
    });

    let adjusted = 0;
    let blocked = 0;
    let noDrift = 0;
    for (const r of rows) {
      if (r.starting_cash_adjusted) adjusted++;
      else if (r.delta != null && Math.abs(r.delta) < 0.5) noDrift++;
      else blocked++;
    }
    return {
      rows,
      totals: { total: rows.length, adjusted, blocked, noDrift },
    };
  });
