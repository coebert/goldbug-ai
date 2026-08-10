// Analytics feed: every order the breakout gate had an opinion on.
//
// Reads ai_decision_audit rows whose market_inputs carry a `breakout` block
// (written by the trading engine at sizing time) and flattens them into a
// per-order list showing the regime cell expectancy, the volatility inputs the
// gate read, and the exact skip / downsize reason.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { BreakoutDecisionAudit } from "./breakout-decision-audit";

export type BreakoutOrderRow = {
  id: string;
  symbol: string;
  action: string;
  outcome: string;
  outcome_detail: string | null;
  decided_at: string;
  run_date: string;
  requested_quantity: number | null;
  price: number | null;
  notional: number | null;
  instrument_ccy: string | null;
  rationale: string | null;
  breakout: BreakoutDecisionAudit;
};

export type BreakoutOrderFeed = {
  rows: BreakoutOrderRow[];
  counts: { total: number; trade: number; downsize: number; skip: number };
  windowDays: number;
};

type RawRow = {
  id: string;
  symbol: string;
  action: string;
  outcome: string;
  outcome_detail: string | null;
  decided_at: string;
  run_date: string;
  requested_quantity: number | null;
  price: number | null;
  notional: number | null;
  instrument_ccy: string | null;
  rationale: string | null;
  market_inputs: unknown;
};

function breakoutBlockOf(mi: unknown): BreakoutDecisionAudit | null {
  if (!mi || typeof mi !== "object") return null;
  const b = (mi as Record<string, unknown>)["breakout"];
  if (!b || typeof b !== "object") return null;
  const rec = b as Record<string, unknown>;
  if (rec["applies"] !== true) return null;
  return rec as unknown as BreakoutDecisionAudit;
}

export const getBreakoutOrderFeed = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        windowDays: z.number().int().min(1).max(365).default(30),
        action: z.enum(["all", "trade", "downsize", "skip"]).default("all"),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<BreakoutOrderFeed> => {
    const since = new Date(Date.now() - data.windowDays * 86_400_000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("ai_decision_audit")
      .select(
        "id, symbol, action, outcome, outcome_detail, decided_at, run_date, requested_quantity, price, notional, instrument_ccy, rationale, market_inputs",
      )
      .eq("portfolio_id", data.portfolioId)
      .gte("decided_at", since)
      .order("decided_at", { ascending: false })
      .limit(4000);
    if (error) throw new Error(error.message);

    const all: BreakoutOrderRow[] = [];
    for (const r of (rows ?? []) as RawRow[]) {
      const b = breakoutBlockOf(r.market_inputs);
      if (!b) continue;
      all.push({
        id: r.id,
        symbol: r.symbol,
        action: r.action,
        outcome: r.outcome,
        outcome_detail: r.outcome_detail,
        decided_at: r.decided_at,
        run_date: r.run_date,
        requested_quantity: r.requested_quantity,
        price: r.price,
        notional: r.notional,
        instrument_ccy: r.instrument_ccy,
        rationale: r.rationale,
        breakout: b,
      });
    }

    const counts = {
      total: all.length,
      trade: all.filter((r) => r.breakout.action === "trade").length,
      downsize: all.filter((r) => r.breakout.action === "downsize").length,
      skip: all.filter((r) => r.breakout.action === "skip").length,
    };

    const filtered =
      data.action === "all" ? all : all.filter((r) => r.breakout.action === data.action);

    return { rows: filtered.slice(0, data.limit), counts, windowDays: data.windowDays };
  });
