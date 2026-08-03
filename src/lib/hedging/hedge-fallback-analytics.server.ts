// Server-side loader for hedge instrument-fallback analytics.
//
// Reads through the caller's own Supabase client so RLS scopes decisions and
// portfolios to the owner — no service_role here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  buildHedgeFallbackSummary,
  type HedgeFallbackSummary,
  type HedgeRunRecord,
} from "./hedge-fallback-analytics";

type RawExecution = {
  applied?: boolean;
  symbol?: string | null;
  qty?: number;
  notional?: number;
  reason?: string | null;
};

type RawReconciliation = {
  advised?: { action?: string; targetNotional?: number };
  applied?: { action?: string; notional?: number; reason?: string | null; applied?: boolean };
  slippage?: { kind?: string };
  deferralReason?: string | null;
  observed?: { notional?: number };
};

function sideOf(action: unknown): HedgeRunRecord["side"] {
  const a = String(action ?? "").toLowerCase();
  if (a === "buy" || a === "sell" || a === "hold") return a;
  return "none";
}

function slippageOf(kind: unknown): HedgeRunRecord["slippageKind"] {
  const k = String(kind ?? "");
  return k === "none" || k === "partial" || k === "unfilled" || k === "over" ? k : null;
}

export async function buildHedgeFallbackReport(params: {
  db: SupabaseClient<Database>;
  userId: string;
  portfolioId?: string;
  days: number;
}): Promise<HedgeFallbackSummary> {
  const { db, userId, portfolioId, days } = params;
  const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  let pfQuery = db.from("portfolios").select("id, name, currency").eq("user_id", userId);
  if (portfolioId) pfQuery = pfQuery.eq("id", portfolioId);
  const pf = await pfQuery;
  if (pf.error) throw new Error(pf.error.message);

  const portfolios = new Map(
    (pf.data ?? []).map((p) => [
      p.id as string,
      { name: (p.name as string) ?? "Portfolio", currency: (p.currency as string) ?? "GBP" },
    ]),
  );
  if (portfolios.size === 0) return buildHedgeFallbackSummary([]);

  const decisions = await db
    .from("decisions")
    .select("id, run_date, portfolio_id, raw")
    .in("portfolio_id", [...portfolios.keys()])
    .gte("run_date", sinceDate)
    .order("run_date", { ascending: false })
    .limit(600);
  if (decisions.error) throw new Error(decisions.error.message);

  const records: HedgeRunRecord[] = [];
  for (const d of decisions.data ?? []) {
    const raw = (d.raw ?? {}) as {
      tail_hedge?: { targetNotional?: number; action?: string } | null;
      tail_hedge_execution?: RawExecution | null;
      tail_hedge_reconciliation?: RawReconciliation | null;
    };
    const exec = raw.tail_hedge_execution;
    if (!exec) continue;
    const recon = raw.tail_hedge_reconciliation ?? null;
    const meta = portfolios.get(d.portfolio_id as string);

    records.push({
      decisionId: d.id as string,
      runDate: d.run_date as string,
      portfolioId: d.portfolio_id as string,
      portfolioName: meta?.name ?? "Portfolio",
      currency: meta?.currency ?? "GBP",
      symbol: exec.symbol ?? null,
      side: sideOf(recon?.advised?.action ?? raw.tail_hedge?.action),
      applied: Boolean(exec.applied),
      reason: exec.reason ?? recon?.applied?.reason ?? null,
      appliedNotional: Number(exec.notional ?? recon?.applied?.notional ?? 0) || 0,
      targetNotional:
        Number(recon?.advised?.targetNotional ?? raw.tail_hedge?.targetNotional ?? 0) || 0,
      observedNotional: Number(recon?.observed?.notional ?? 0) || 0,
      slippageKind: slippageOf(recon?.slippage?.kind),
      deferralReason: recon?.deferralReason ?? null,
    });
  }

  return buildHedgeFallbackSummary(records);
}
