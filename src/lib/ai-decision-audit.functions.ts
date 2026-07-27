// Paginated reader for the AI decision audit log. RLS on the authenticated
// Supabase client scopes rows to the calling user's portfolios.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

type Json = string | number | boolean | null | { [k: string]: Json } | Json[];

export type AiDecisionAuditRow = {
  id: string;
  decision_id: string | null;
  portfolio_id: string;
  run_date: string;
  decided_at: string;
  symbol: string;
  asset_class: string | null;
  action: "buy" | "sell" | "hold";
  source: string;
  model: string | null;
  requested_quantity: number | string | null;
  price: number | string | null;
  notional: number | string | null;
  instrument_ccy: string | null;
  rationale: string | null;
  market_inputs: Json;
  order_id: string | null;
  outcome: string;
  outcome_detail: string | null;
  outcome_at: string | null;
};

export type AiDecisionAuditPage = {
  rows: AiDecisionAuditRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};

export const listAiDecisionAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        action: z.enum(["buy", "sell", "hold"]).optional(),
        outcome: z
          .enum([
            "pending", "placed", "filled", "partial", "rejected",
            "cancelled", "skipped", "hold", "error",
          ])
          .optional(),
        symbol: z.string().min(1).max(32).optional(),
        page: z.number().int().min(0).max(10_000).default(0),
        pageSize: z.number().int().min(1).max(200).default(50),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<AiDecisionAuditPage> => {
    const from = data.page * data.pageSize;
    const to = from + data.pageSize - 1;
    let q = context.supabase
      .from("ai_decision_audit")
      .select(
        "id, decision_id, portfolio_id, run_date, decided_at, symbol, asset_class, action, source, model, requested_quantity, price, notional, instrument_ccy, rationale, market_inputs, order_id, outcome, outcome_detail, outcome_at",
        { count: "exact" },
      )
      .eq("portfolio_id", data.portfolioId)
      .order("decided_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);
    if (data.action) q = q.eq("action", data.action);
    if (data.outcome) q = q.eq("outcome", data.outcome);
    if (data.symbol) q = q.eq("symbol", data.symbol.toUpperCase());
    const { data: rows, count, error } = await q;
    if (error) throw new Error(error.message);
    const total = count ?? 0;
    return {
      rows: (rows ?? []) as AiDecisionAuditRow[],
      page: data.page,
      pageSize: data.pageSize,
      total,
      hasMore: from + (rows?.length ?? 0) < total,
    };
  });
