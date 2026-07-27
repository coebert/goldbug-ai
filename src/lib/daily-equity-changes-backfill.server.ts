// Server-only helpers for backfilling daily equity change rows.
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeDailyEquityChanges, type DepositLite } from "./daily-equity-changes";

export type BackfillResult = {
  portfolioId: string;
  snapshots: number;
  rowsWritten: number;
  fromDate: string | null;
  toDate: string | null;
  skipped?: string;
};

async function loadDeposits(
  supabase: SupabaseClient,
  portfolioId: string,
  mode: string | null | undefined,
): Promise<DepositLite[]> {
  const deposits: DepositLite[] = [];
  if (mode === "live_prod" || mode === "live_sim") {
    const { data: rows } = await supabase
      .from("live_broker_log")
      .select("created_at, response, status, method")
      .eq("portfolio_id", portfolioId)
      .eq("method", "CASH_SYNC")
      .eq("status", 200);
    for (const row of rows ?? []) {
      if (!row.created_at) continue;
      const resp = (row.response ?? {}) as {
        delta?: number | string;
        startingCashAdjusted?: boolean;
      };
      if (!resp.startingCashAdjusted) continue;
      const amt = Number(resp.delta);
      if (!Number.isFinite(amt) || amt === 0) continue;
      deposits.push({ date: String(row.created_at).slice(0, 10), amount: amt });
    }
  } else {
    const { data: rows } = await supabase
      .from("sim_fund_events")
      .select("amount, created_at")
      .eq("portfolio_id", portfolioId);
    for (const e of rows ?? []) {
      if (!e.created_at) continue;
      const amt = Number(e.amount);
      if (!Number.isFinite(amt)) continue;
      deposits.push({ date: String(e.created_at).slice(0, 10), amount: amt });
    }
  }
  return deposits;
}

export async function backfillPortfolioDailyChanges(
  supabase: SupabaseClient,
  portfolio: { id: string; mode?: string | null },
  days: number,
): Promise<BackfillResult> {
  const portfolioId = portfolio.id;
  // Fetch one extra snapshot before the window so the first in-window day
  // has a `prev` anchor.
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(1, days) - 1);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const { data: equity, error: eqErr } = await supabase
    .from("equity_snapshots")
    .select("snapshot_date,total_value")
    .eq("portfolio_id", portfolioId)
    .gte("snapshot_date", cutoffIso)
    .order("snapshot_date", { ascending: true });
  if (eqErr) throw eqErr;

  const deposits = await loadDeposits(supabase, portfolioId, portfolio.mode ?? null);
  const changes = computeDailyEquityChanges(equity ?? [], deposits);

  // Drop the anchor day (prev-only) — keep only rows whose change_date lies
  // within the requested window.
  const windowStart = new Date();
  windowStart.setUTCDate(windowStart.getUTCDate() - Math.max(1, days));
  const windowStartIso = windowStart.toISOString().slice(0, 10);
  const inWindow = changes.filter((c) => c.date >= windowStartIso);

  if (inWindow.length === 0) {
    return {
      portfolioId,
      snapshots: equity?.length ?? 0,
      rowsWritten: 0,
      fromDate: null,
      toDate: null,
      skipped: (equity?.length ?? 0) < 2 ? "not-enough-snapshots" : "no-in-window-rows",
    };
  }

  const payload = inWindow.map((c) => ({
    portfolio_id: portfolioId,
    change_date: c.date,
    prev_date: c.prevDate,
    prev_equity: c.prevEquity,
    equity: c.equity,
    raw_delta: c.rawDelta,
    net_flow: c.netFlow,
    pnl: c.pnl,
    pct: c.pct,
    computed_at: new Date().toISOString(),
  }));

  const { error: upErr } = await supabase
    .from("daily_equity_changes")
    .upsert(payload, { onConflict: "portfolio_id,change_date" });
  if (upErr) throw upErr;

  return {
    portfolioId,
    snapshots: equity?.length ?? 0,
    rowsWritten: payload.length,
    fromDate: payload[0].change_date,
    toDate: payload[payload.length - 1].change_date,
  };
}
