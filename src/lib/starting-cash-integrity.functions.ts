// Server-fn that runs the starting-cash integrity check across every
// portfolio the caller owns. RLS on the authenticated Supabase client
// scopes the reads; deposits are pulled from `sim_fund_events` for
// sim/paper modes and from `live_broker_log` CASH_SYNC unexplained-delta
// entries for live_prod / live_sim modes.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildStartingCashIntegrityReport,
  type DepositRecord,
  type StartingCashIntegrityInput,
  type StartingCashIntegrityReport,
} from "./starting-cash-integrity";

export type { StartingCashIntegrityReport } from "./starting-cash-integrity";

export const runStartingCashIntegrityCheck = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<StartingCashIntegrityReport> => {
    const { data: portfolios, error } = await context.supabase
      .from("portfolios")
      .select("id,name,currency,mode,starting_cash,current_cash,created_at")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const list = portfolios ?? [];
    if (list.length === 0) return buildStartingCashIntegrityReport([]);

    const ids = list.map((p) => p.id);

    const simIds = list.filter((p) => p.mode !== "live_prod").map((p) => p.id);
    const liveIds = list
      .filter((p) => p.mode === "live_prod" || p.mode === "live_sim")
      .map((p) => p.id);

    const depositsByPortfolio = new Map<string, DepositRecord[]>();

    if (simIds.length > 0) {
      const { data: simEvents } = await context.supabase
        .from("sim_fund_events")
        .select("portfolio_id, amount, balance_after, created_at")
        .in("portfolio_id", simIds)
        .order("created_at", { ascending: true });
      for (const e of simEvents ?? []) {
        if (!e.portfolio_id || !e.created_at) continue;
        const amt = Number(e.amount);
        if (!Number.isFinite(amt)) continue;
        const arr = depositsByPortfolio.get(e.portfolio_id) ?? [];
        arr.push({
          date: String(e.created_at).slice(0, 10),
          amount: amt,
          balanceAfter:
            e.balance_after != null && Number.isFinite(Number(e.balance_after))
              ? Number(e.balance_after)
              : null,
        });
        depositsByPortfolio.set(e.portfolio_id, arr);
      }
    }

    if (liveIds.length > 0) {
      const { data: cashSyncs } = await context.supabase
        .from("live_broker_log")
        .select("portfolio_id, created_at, response")
        .in("portfolio_id", liveIds)
        .eq("method", "CASH_SYNC")
        .eq("status", 200)
        .order("created_at", { ascending: true });
      for (const row of cashSyncs ?? []) {
        if (!row.portfolio_id || !row.created_at) continue;
        const resp = (row.response ?? {}) as {
          delta?: number | string;
          startingCashAdjusted?: boolean;
        };
        if (!resp.startingCashAdjusted) continue;
        const amt = Number(resp.delta);
        if (!Number.isFinite(amt) || amt === 0) continue;
        const arr = depositsByPortfolio.get(row.portfolio_id) ?? [];
        arr.push({
          date: String(row.created_at).slice(0, 10),
          amount: amt,
          balanceAfter: null,
        });
        depositsByPortfolio.set(row.portfolio_id, arr);
      }
    }

    const { data: allEq } = await context.supabase
      .from("equity_snapshots")
      .select("portfolio_id, snapshot_date, total_value")
      .in("portfolio_id", ids)
      .order("snapshot_date", { ascending: true });

    const earliestSnapshot = new Map<string, { date: string; totalValue: number }>();
    for (const s of allEq ?? []) {
      if (!s.portfolio_id || !s.snapshot_date) continue;
      if (earliestSnapshot.has(s.portfolio_id)) continue;
      const tv = Number(s.total_value);
      if (!Number.isFinite(tv)) continue;
      earliestSnapshot.set(s.portfolio_id, { date: s.snapshot_date, totalValue: tv });
    }

    const inputs: StartingCashIntegrityInput[] = list.map((p) => ({
      portfolioId: p.id,
      portfolioName: p.name,
      currency: p.currency,
      mode: p.mode,
      startingCash: Number(p.starting_cash),
      currentCash: Number(p.current_cash),
      deposits: depositsByPortfolio.get(p.id) ?? [],
      earliestSnapshot: earliestSnapshot.get(p.id) ?? null,
    }));

    return buildStartingCashIntegrityReport(inputs);
  });
