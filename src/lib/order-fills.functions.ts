// Real broker order/fill view: every recent order joined to the fills the
// broker actually reported, so the UI can show status, fees and execution time
// per order instead of a local status guess.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type OrderFillRow = {
  orderId: string;
  symbol: string;
  side: string;
  status: string;
  brokerOrderId: string | null;
  rejectReason: string | null;
  currency: string;
  orderedQty: number;
  filledQty: number;
  avgFillPrice: number | null;
  limitPrice: number | null;
  notional: number | null;
  fee: number;
  feeBreakdown: { commission: number; exchange: number; tax: number; other: number };
  feeSource: string;
  feeBps: number | null;
  submittedAt: string | null;
  firstFillAt: string | null;
  lastFillAt: string | null;
  /** Milliseconds from submission to the last fill, when both are known. */
  executionMs: number | null;
  fillCount: number;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const getOrderFills = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        limit: z.number().int().min(1).max(200).default(40),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<{ rows: OrderFillRow[]; feeCoverage: number }> => {
    const { supabase, userId } = context;

    const { data: orders, error } = await supabase
      .from("live_orders")
      .select(
        "id, symbol, side, status, quantity, limit_price, broker_order_id, reject_reason, submitted_at, created_at, instrument_ccy",
      )
      .eq("portfolio_id", data.portfolioId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    if (!orders || orders.length === 0) return { rows: [], feeCoverage: 1 };

    const ids = orders.map((o) => String(o.id));
    const { data: fills } = await supabase
      .from("live_fills")
      .select(
        "order_id, quantity, fill_price, fee, fee_commission, fee_exchange, fee_tax, fee_other, fee_source, currency, filled_at",
      )
      .in("order_id", ids);

    const byOrder = new Map<string, typeof fills>();
    for (const f of fills ?? []) {
      const key = String(f.order_id);
      const list = byOrder.get(key) ?? [];
      list.push(f);
      byOrder.set(key, list);
    }

    let withBrokerFees = 0;
    let filledOrders = 0;

    const rows: OrderFillRow[] = orders.map((o) => {
      const legs = byOrder.get(String(o.id)) ?? [];
      const filledQty = legs.reduce((s, f) => s + num(f.quantity), 0);
      const gross = legs.reduce((s, f) => s + num(f.quantity) * num(f.fill_price), 0);
      const fee = legs.reduce((s, f) => s + num(f.fee), 0);
      const times = legs
        .map((f) => new Date(String(f.filled_at)).getTime())
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b);
      const submitted = o.submitted_at ? new Date(String(o.submitted_at)).getTime() : null;
      const lastFill = times.length ? times[times.length - 1]! : null;
      const avg = filledQty > 0 ? gross / filledQty : null;
      const feeSource = legs.find((f) => f.fee_source && f.fee_source !== "none")?.fee_source ?? "none";
      if (legs.length > 0) {
        filledOrders += 1;
        if (feeSource === "broker") withBrokerFees += 1;
      }

      return {
        orderId: String(o.id),
        symbol: String(o.symbol),
        side: String(o.side),
        status: String(o.status),
        brokerOrderId: o.broker_order_id ? String(o.broker_order_id) : null,
        rejectReason: o.reject_reason ? String(o.reject_reason) : null,
        currency: String(legs[0]?.currency ?? o.instrument_ccy ?? "GBP"),
        orderedQty: num(o.quantity),
        filledQty,
        avgFillPrice: avg,
        limitPrice: o.limit_price == null ? null : num(o.limit_price),
        notional: filledQty > 0 ? gross : null,
        fee,
        feeBreakdown: {
          commission: legs.reduce((s, f) => s + num(f.fee_commission), 0),
          exchange: legs.reduce((s, f) => s + num(f.fee_exchange), 0),
          tax: legs.reduce((s, f) => s + num(f.fee_tax), 0),
          other: legs.reduce((s, f) => s + num(f.fee_other), 0),
        },
        feeSource,
        feeBps: gross > 0 ? (fee / gross) * 10_000 : null,
        submittedAt: o.submitted_at ? String(o.submitted_at) : null,
        firstFillAt: times.length ? new Date(times[0]!).toISOString() : null,
        lastFillAt: lastFill ? new Date(lastFill).toISOString() : null,
        executionMs: submitted && lastFill ? Math.max(0, lastFill - submitted) : null,
        fillCount: legs.length,
      };
    });

    return { rows, feeCoverage: filledOrders > 0 ? withBrokerFees / filledOrders : 1 };
  });
