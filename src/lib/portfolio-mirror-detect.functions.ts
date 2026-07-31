// Server-side reconciliation check for mirrored portfolios.
//
// Reads every portfolio for the caller, pairs its latest equity snapshot with
// its live holdings book, and runs the pure detector. Any error-severity
// finding is surfaced to the caller so the UI can show a hard reconciliation
// error with the exact cause (shared or missing broker account link).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  detectMirroredPortfolios,
  hasMirrorError,
  type MirrorFinding,
  type MirrorPortfolioInput,
} from "@/lib/portfolio-mirror-detect";

export interface MirrorCheckResult {
  checkedAt: string;
  portfoliosChecked: number;
  findings: MirrorFinding[];
  hasError: boolean;
}

export const checkPortfolioMirrors = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MirrorCheckResult> => {
    const { data: portfolios, error: pErr } = await context.supabase
      .from("portfolios")
      .select(
        "id, name, mode, risk_level, broker, broker_account_id, current_cash, currency, status",
      )
      .in("status", ["active", "paused"]);
    if (pErr) throw new Error(pErr.message);

    const active = (portfolios ?? []).filter(Boolean);
    if (active.length < 2) {
      return {
        checkedAt: new Date().toISOString(),
        portfoliosChecked: active.length,
        findings: [],
        hasError: false,
      };
    }

    const ids = active.map((p) => p.id);

    const [{ data: holdings }, { data: snapshots }] = await Promise.all([
      context.supabase
        .from("holdings")
        .select("portfolio_id, symbol, quantity, avg_cost")
        .in("portfolio_id", ids),
      context.supabase
        .from("equity_snapshots")
        .select("portfolio_id, snapshot_date, total_value, cash")
        .in("portfolio_id", ids)
        .order("snapshot_date", { ascending: false }),
    ]);

    const holdingsBy = new Map<string, MirrorPortfolioInput["holdings"]>();
    for (const h of holdings ?? []) {
      const list = holdingsBy.get(h.portfolio_id) ?? [];
      list.push({ symbol: h.symbol, quantity: Number(h.quantity) || 0, avg_cost: h.avg_cost });
      holdingsBy.set(h.portfolio_id, list);
    }

    // Snapshots come back newest-first, so the first row per portfolio wins.
    const latestEquity = new Map<string, number>();
    for (const s of snapshots ?? []) {
      if (!latestEquity.has(s.portfolio_id)) {
        latestEquity.set(s.portfolio_id, Number(s.total_value) || 0);
      }
    }

    const inputs: MirrorPortfolioInput[] = active.map((p) => {
      const book = holdingsBy.get(p.id) ?? [];
      const cash = Number(p.current_cash) || 0;
      const bookValue = book.reduce(
        (sum, h) => sum + (Number(h.quantity) || 0) * (Number(h.avg_cost) || 0),
        0,
      );
      return {
        id: p.id,
        name: p.name,
        mode: p.mode,
        risk_level: p.risk_level,
        broker: p.broker,
        broker_account_id: p.broker_account_id,
        current_cash: cash,
        equity: latestEquity.get(p.id) ?? cash + bookValue,
        currency: p.currency,
        holdings: book,
      };
    });

    const findings = detectMirroredPortfolios(inputs);

    return {
      checkedAt: new Date().toISOString(),
      portfoliosChecked: inputs.length,
      findings,
      hasError: hasMirrorError(findings),
    };
  });
