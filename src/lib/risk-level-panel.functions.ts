// Loads everything the risk-level verification panel needs in one round trip:
// portfolios grouped by risk level, their holdings books and their equity
// history over a bounded lookback window.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  computeRiskLevelPanel,
  checkRiskLadder,
  type RiskLevelMetrics,
  type RiskLadderWarning,
  type RiskPanelPortfolio,
} from "@/lib/risk-level-panel";

export interface RiskLevelPanelResult {
  computedAt: string;
  lookbackDays: number;
  rows: RiskLevelMetrics[];
  warnings: RiskLadderWarning[];
  currency: string;
}

const LOOKBACK_DAYS = 90;

export const getRiskLevelPanel = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RiskLevelPanelResult> => {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const { data: portfolios, error } = await context.supabase
      .from("portfolios")
      .select("id, name, mode, risk_level, currency, current_cash, status")
      .in("status", ["active", "paused"]);
    if (error) throw new Error(error.message);

    const list = portfolios ?? [];
    const empty: RiskLevelPanelResult = {
      computedAt: new Date().toISOString(),
      lookbackDays: LOOKBACK_DAYS,
      rows: [],
      warnings: [],
      currency: list[0]?.currency ?? "GBP",
    };
    if (list.length === 0) return empty;

    const ids = list.map((p) => p.id);
    const [{ data: holdings }, { data: snapshots }] = await Promise.all([
      context.supabase
        .from("holdings")
        .select("portfolio_id, symbol, quantity, avg_cost, current_price")
        .in("portfolio_id", ids),
      context.supabase
        .from("equity_snapshots")
        .select("portfolio_id, snapshot_date, total_value")
        .in("portfolio_id", ids)
        .gte("snapshot_date", since)
        .order("snapshot_date", { ascending: true }),
    ]);

    const holdingsBy = new Map<string, RiskPanelPortfolio["holdings"]>();
    for (const h of holdings ?? []) {
      const row = h as typeof h & { current_price?: number | null };
      const price = Number(row.current_price) || Number(row.avg_cost) || 0;
      const list = holdingsBy.get(h.portfolio_id) ?? [];
      list.push({ symbol: h.symbol, quantity: Number(h.quantity) || 0, price });
      holdingsBy.set(h.portfolio_id, list);
    }

    const equityBy = new Map<string, RiskPanelPortfolio["equity"]>();
    for (const s of snapshots ?? []) {
      const list = equityBy.get(s.portfolio_id) ?? [];
      list.push({
        snapshot_date: s.snapshot_date,
        total_value: Number(s.total_value) || 0,
      });
      equityBy.set(s.portfolio_id, list);
    }

    const inputs: RiskPanelPortfolio[] = list.map((p) => ({
      id: p.id,
      name: p.name,
      mode: p.mode,
      riskLevel: p.risk_level,
      currency: p.currency,
      cash: Number(p.current_cash) || 0,
      holdings: holdingsBy.get(p.id) ?? [],
      equity: equityBy.get(p.id) ?? [],
    }));

    const rows = computeRiskLevelPanel(inputs);
    return {
      computedAt: new Date().toISOString(),
      lookbackDays: LOOKBACK_DAYS,
      rows,
      warnings: checkRiskLadder(rows),
      currency: list[0]?.currency ?? "GBP",
    };
  });
