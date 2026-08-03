import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { InputSchema } from "./order-reconciliation-view.helpers";
import type { ReconOrderRow } from "./order-reconciliation-view.helpers";
export type { ReconOrderRow };

export const listRecentOrderReconciliation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => InputSchema.parse(v ?? {}))
  .handler(async ({ data, context }): Promise<ReconOrderRow[]> => {
    const sinceIso = new Date(Date.now() - data.hours * 3600_000).toISOString();
    let q = context.supabase
      .from("live_orders")
      .select(
        "id, portfolio_id, symbol, side, quantity, order_type, status, broker_order_id, reject_reason, submitted_at, created_at, updated_at, portfolios(name)",
      )
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(300);
    if (data.portfolioId) q = q.eq("portfolio_id", data.portfolioId);
    const orders = await q;
    if (orders.error) throw new Error(orders.error.message);
    const rows = orders.data ?? [];
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id as string);
    const fills = await context.supabase
      .from("live_fills")
      .select("order_id, filled_at, quantity, fill_price")
      .in("order_id", ids);
    if (fills.error) throw new Error(fills.error.message);

    const byOrder = new Map<string, { first: string; qty: number; notional: number }>();
    for (const f of fills.data ?? []) {
      const oid = f.order_id as string;
      const at = f.filled_at as string;
      const qty = Number(f.quantity ?? 0);
      const px = Number(f.fill_price ?? 0);
      const cur = byOrder.get(oid);
      if (!cur) {
        byOrder.set(oid, { first: at, qty, notional: qty * px });
      } else {
        cur.qty += qty;
        cur.notional += qty * px;
        if (at < cur.first) cur.first = at;
      }
    }

    return rows.map((r) => {
      const agg = byOrder.get(r.id as string);
      const submitted = r.submitted_at as string | null;
      const latency =
        agg?.first && submitted
          ? new Date(agg.first).getTime() - new Date(submitted).getTime()
          : null;
      const portfolios = r.portfolios as { name?: string | null } | null;
      return {
        id: r.id as string,
        portfolio_id: r.portfolio_id as string,
        portfolio_name: portfolios?.name ?? null,
        symbol: r.symbol as string,
        side: r.side as string,
        quantity: Number(r.quantity ?? 0),
        order_type: (r.order_type as string) ?? "market",
        status: r.status as string,
        broker_order_id: (r.broker_order_id as string | null) ?? null,
        reject_reason: (r.reject_reason as string | null) ?? null,
        submitted_at: submitted,
        created_at: r.created_at as string,
        updated_at: r.updated_at as string,
        first_fill_at: agg?.first ?? null,
        latency_ms: latency,
        filled_quantity: agg?.qty ?? 0,
        avg_fill_price: agg && agg.qty > 0 ? agg.notional / agg.qty : null,
      };
    });
  });
