// Metrics: intended-vs-executed trade rates per portfolio and per symbol.
// Derived from ai_decision_audit rows over a configurable lookback window.
//
// Intended  = action IN ('buy','sell')
// Executed  = outcome IN ('placed','filled','partial')      — reached broker
// Filled    = outcome IN ('filled','partial')               — actually traded
// Missed    = intended AND outcome IN ('rejected','skipped','cancelled','error')
//
// A near-zero executed_rate for a portfolio (or a chronic per-symbol miss)
// is the same class of regression as the "empty live_orders for two cycles"
// alert — surfaced here as a live UI + used by the per-symbol alerter.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type SymbolFillMetric = {
  symbol: string;
  intended: number;
  executed: number;
  filled: number;
  missed: number;
  executed_rate: number;   // executed / intended
  fill_rate: number;       // filled / intended
  top_miss_reason: string | null;
};

export type IntendedVsExecutedMetrics = {
  portfolioId: string;
  windowHours: number;
  since: string;
  intended: number;
  executed: number;
  filled: number;
  missed: number;
  executed_rate: number;
  fill_rate: number;
  symbols: SymbolFillMetric[];
  // Bucket counts for the tile row.
  outcomes: Record<string, number>;
};

const EXECUTED = new Set(["placed", "filled", "partial"]);
const FILLED = new Set(["filled", "partial"]);
const MISSED = new Set(["rejected", "skipped", "cancelled", "error"]);

type AuditRow = {
  symbol: string;
  action: string;
  outcome: string;
  outcome_detail: string | null;
};

export function computeIntendedVsExecuted(
  rows: AuditRow[],
  portfolioId: string,
  windowHours: number,
  since: string,
): IntendedVsExecutedMetrics {
  const outcomes: Record<string, number> = {};
  const perSym = new Map<
    string,
    { intended: number; executed: number; filled: number; missed: number; reasons: Map<string, number> }
  >();

  let intended = 0;
  let executed = 0;
  let filled = 0;
  let missed = 0;

  for (const r of rows) {
    const oc = String(r.outcome ?? "").toLowerCase();
    outcomes[oc] = (outcomes[oc] ?? 0) + 1;
    const isIntent = r.action === "buy" || r.action === "sell";
    if (!isIntent) continue;

    const sym = String(r.symbol ?? "").toUpperCase();
    let bucket = perSym.get(sym);
    if (!bucket) {
      bucket = { intended: 0, executed: 0, filled: 0, missed: 0, reasons: new Map() };
      perSym.set(sym, bucket);
    }
    bucket.intended += 1;
    intended += 1;

    if (EXECUTED.has(oc)) { bucket.executed += 1; executed += 1; }
    if (FILLED.has(oc))   { bucket.filled += 1;   filled   += 1; }
    if (MISSED.has(oc)) {
      bucket.missed += 1;
      missed += 1;
      const reason = (r.outcome_detail ?? oc).toString().slice(0, 120);
      bucket.reasons.set(reason, (bucket.reasons.get(reason) ?? 0) + 1);
    }
  }

  const symbols: SymbolFillMetric[] = Array.from(perSym.entries())
    .map(([symbol, b]) => {
      let topReason: string | null = null;
      let topCount = 0;
      for (const [r, n] of b.reasons) if (n > topCount) { topReason = r; topCount = n; }
      return {
        symbol,
        intended: b.intended,
        executed: b.executed,
        filled: b.filled,
        missed: b.missed,
        executed_rate: b.intended > 0 ? b.executed / b.intended : 0,
        fill_rate: b.intended > 0 ? b.filled / b.intended : 0,
        top_miss_reason: topReason,
      };
    })
    .sort((a, b) =>
      a.executed_rate - b.executed_rate || b.intended - a.intended || a.symbol.localeCompare(b.symbol),
    );

  return {
    portfolioId,
    windowHours,
    since,
    intended,
    executed,
    filled,
    missed,
    executed_rate: intended > 0 ? executed / intended : 0,
    fill_rate: intended > 0 ? filled / intended : 0,
    symbols,
    outcomes,
  };
}

export const getIntendedVsExecutedMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        windowHours: z.number().int().min(1).max(24 * 30).default(72),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<IntendedVsExecutedMetrics> => {
    const since = new Date(Date.now() - data.windowHours * 3600_000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("ai_decision_audit")
      .select("symbol, action, outcome, outcome_detail")
      .eq("portfolio_id", data.portfolioId)
      .gte("decided_at", since)
      .limit(10_000);
    if (error) throw new Error(error.message);
    return computeIntendedVsExecuted(
      (rows ?? []) as AuditRow[],
      data.portfolioId,
      data.windowHours,
      since,
    );
  });
