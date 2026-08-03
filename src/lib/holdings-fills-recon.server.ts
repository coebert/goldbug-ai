// Data loader for the holdings-vs-fills reconciliation check.
//
// Runs under the caller's Supabase client so RLS scopes every read to the
// portfolios they own — no service_role, no cross-user leakage.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  reconcileHoldingsAgainstFills,
  type ReconSummary,
} from "./holdings-fills-recon";

export type PortfolioReconReport = ReconSummary & {
  portfolios: Array<{ id: string; name: string | null }>;
  generatedAt: string;
};

const FILL_PAGE = 1000;

export async function buildHoldingsFillsReconReport(params: {
  db: SupabaseClient<Database>;
  userId: string;
  portfolioId?: string;
  includeMatches?: boolean;
}): Promise<PortfolioReconReport> {
  const { db, userId } = params;

  let pfQuery = db.from("portfolios").select("id, name").eq("user_id", userId);
  if (params.portfolioId) pfQuery = pfQuery.eq("id", params.portfolioId);
  const pf = await pfQuery;
  if (pf.error) throw new Error(pf.error.message);

  const portfolios = (pf.data ?? []).map((p) => ({
    id: p.id as string,
    name: (p.name as string | null) ?? null,
  }));
  const ids = portfolios.map((p) => p.id);

  if (ids.length === 0) {
    return {
      ...reconcileHoldingsAgainstFills({ fills: [], holdings: [] }),
      portfolios,
      generatedAt: new Date().toISOString(),
    };
  }

  // Fills can run to thousands of rows; page rather than silently truncating
  // at PostgREST's default limit, which would fabricate mismatches.
  const fills: Array<{ portfolioId: string; symbol: string; side: string | null; quantity: number }> =
    [];
  for (let from = 0; ; from += FILL_PAGE) {
    const page = await db
      .from("live_fills")
      .select("portfolio_id, symbol, side, quantity")
      .in("portfolio_id", ids)
      .order("filled_at", { ascending: true })
      .range(from, from + FILL_PAGE - 1);
    if (page.error) throw new Error(page.error.message);
    const rows = page.data ?? [];
    for (const r of rows) {
      fills.push({
        portfolioId: r.portfolio_id as string,
        symbol: String(r.symbol),
        side: (r.side as string | null) ?? null,
        quantity: Number(r.quantity ?? 0),
      });
    }
    if (rows.length < FILL_PAGE) break;
  }

  const hold = await db
    .from("holdings")
    .select("portfolio_id, symbol, quantity, avg_cost")
    .in("portfolio_id", ids);
  if (hold.error) throw new Error(hold.error.message);

  const summary = reconcileHoldingsAgainstFills({
    fills,
    holdings: (hold.data ?? []).map((h) => ({
      portfolioId: h.portfolio_id as string,
      symbol: String(h.symbol),
      quantity: Number(h.quantity ?? 0),
      avgCost: Number(h.avg_cost ?? 0),
    })),
    includeMatches: params.includeMatches ?? false,
  });

  return { ...summary, portfolios, generatedAt: new Date().toISOString() };
}
