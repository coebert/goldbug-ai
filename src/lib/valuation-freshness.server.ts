// When was this portfolio's valuation last refreshed against the broker?
//
// Two writers touch live valuation: the holdings/cash sync (which stamps
// holdings.updated_at) and the equity reconciler (which inserts a
// live_reconciliation row). The freshest of the two is what the user sees.

import type { ScopedDbClient } from "@/lib/_server/owned-client";

export type ValuationFreshness = {
  /** ISO timestamp of the most recent valuation write, or null if never. */
  lastRefreshedAt: string | null;
  source: "reconciliation" | "holdings" | null;
};

export async function getValuationFreshness(
  db: ScopedDbClient,
  portfolioId: string,
): Promise<ValuationFreshness> {
  const [recon, holding] = await Promise.all([
    db
      .from("live_reconciliation")
      .select("created_at")
      .eq("portfolio_id", portfolioId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("holdings")
      .select("updated_at")
      .eq("portfolio_id", portfolioId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const reconAt = (recon.data as { created_at?: string } | null)?.created_at ?? null;
  const holdAt = (holding.data as { updated_at?: string } | null)?.updated_at ?? null;

  const reconMs = reconAt ? Date.parse(reconAt) : NaN;
  const holdMs = holdAt ? Date.parse(holdAt) : NaN;

  if (Number.isFinite(reconMs) && (!Number.isFinite(holdMs) || reconMs >= holdMs)) {
    return { lastRefreshedAt: reconAt, source: "reconciliation" };
  }
  if (Number.isFinite(holdMs)) {
    return { lastRefreshedAt: holdAt, source: "holdings" };
  }
  return { lastRefreshedAt: null, source: null };
}
