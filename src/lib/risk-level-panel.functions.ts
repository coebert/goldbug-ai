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
/** Everything is rolled up into the operator's home currency. */
const DISPLAY_CURRENCY = "GBP";

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
      currency: DISPLAY_CURRENCY,
    };
    if (list.length === 0) return empty;

    const ids = list.map((p) => p.id);
    const [{ data: holdings }, { data: snapshots }] = await Promise.all([
      context.supabase
        .from("holdings")
        .select("portfolio_id, symbol, quantity, avg_cost")
        .in("portfolio_id", ids),
      context.supabase
        .from("equity_snapshots")
        .select("portfolio_id, snapshot_date, total_value, cash, holdings_value")
        .in("portfolio_id", ids)
        .gte("snapshot_date", since)
        .order("snapshot_date", { ascending: true }),
    ]);

    // No live price column on holdings — average cost is the weighting proxy,
    // which is fine for relative diversification/concentration figures.
    const holdingsBy = new Map<string, RiskPanelPortfolio["holdings"]>();
    for (const h of holdings ?? []) {
      const list = holdingsBy.get(h.portfolio_id) ?? [];
      list.push({
        symbol: h.symbol,
        quantity: Number(h.quantity) || 0,
        price: Number(h.avg_cost) || 0,
      });
      holdingsBy.set(h.portfolio_id, list);
    }

    const equityBy = new Map<string, RiskPanelPortfolio["equity"]>();
    for (const s of snapshots ?? []) {
      const list = equityBy.get(s.portfolio_id) ?? [];
      list.push({
        snapshot_date: s.snapshot_date,
        total_value: Number(s.total_value) || 0,
        cash: Number(s.cash) || 0,
        holdingsValue: Number(s.holdings_value) || 0,
      });
      equityBy.set(s.portfolio_id, list);
    }

    // Portfolios are booked in their own currency (EUR sims sit next to GBP
    // live books). Resolve every rate into the display currency up front; a
    // missing rate is passed through as null so the panel can say "not
    // comparable" instead of silently adding euros to pounds.
    const { getFxRate } = await import("@/lib/fx.server");
    const currencies = [
      ...new Set(list.map((p) => (p.currency ?? DISPLAY_CURRENCY).toUpperCase())),
    ];
    const rates = new Map<string, number | null>();
    await Promise.all(
      currencies.map(async (ccy) => {
        if (ccy === DISPLAY_CURRENCY) {
          rates.set(ccy, 1);
          return;
        }
        try {
          const fx = await getFxRate(ccy, DISPLAY_CURRENCY);
          // A `fallback:` rate is a hard-coded 1.0 dressed up as FX — treat
          // it as unknown rather than pretending a euro is a pound.
          const usable = fx.rate > 0 && !fx.source.startsWith("fallback:");
          rates.set(ccy, usable ? fx.rate : null);
        } catch {
          rates.set(ccy, null);
        }
      }),
    );

    const inputs: RiskPanelPortfolio[] = list.map((p) => ({
      id: p.id,
      name: p.name,
      mode: p.mode,
      riskLevel: p.risk_level,
      currency: p.currency,
      cash: Number(p.current_cash) || 0,
      holdings: holdingsBy.get(p.id) ?? [],
      equity: equityBy.get(p.id) ?? [],
      fxRate: rates.get((p.currency ?? DISPLAY_CURRENCY).toUpperCase()) ?? null,
    }));

    const rows = computeRiskLevelPanel(inputs);
    return {
      computedAt: new Date().toISOString(),
      lookbackDays: LOOKBACK_DAYS,
      rows,
      warnings: checkRiskLadder(rows),
      currency: DISPLAY_CURRENCY,
    };
  });
