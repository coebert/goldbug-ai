import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { InputSchema } from "./trade-outcomes.helpers";
import type { TradeOutcomeFill, TradeOutcomeRow } from "./trade-outcomes.helpers";
export type { TradeOutcomeFill, TradeOutcomeRow };

export const getTradeOutcomes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const sinceIso = new Date(
      Date.now() - data.sinceHours * 3600_000,
    ).toISOString();

    const ordersQ = await context.supabase
      .from("live_orders")
      .select(
        "id, created_at, updated_at, submitted_at, symbol, side, quantity, order_type, limit_price, status, broker_order_id, client_order_id, reject_reason, instrument_ccy",
      )
      .eq("portfolio_id", data.portfolioId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (ordersQ.error) throw new Error(ordersQ.error.message);
    const orders = ordersQ.data ?? [];

    const orderIds = orders.map((o) => o.id as string);
    let fillsByOrder = new Map<string, TradeOutcomeFill[]>();
    if (orderIds.length > 0) {
      const fillsQ = await context.supabase
        .from("live_fills")
        .select(
          "id, order_id, quantity, fill_price, fee, currency, filled_at",
        )
        .in("order_id", orderIds)
        .order("filled_at", { ascending: true });
      if (fillsQ.error) throw new Error(fillsQ.error.message);
      for (const f of fillsQ.data ?? []) {
        const arr = fillsByOrder.get(f.order_id as string) ?? [];
        arr.push({
          id: f.id as string,
          quantity: Number(f.quantity),
          price: Number(f.fill_price),
          fee: Number(f.fee ?? 0),
          currency: f.currency as string,
          filledAt: f.filled_at as string,
        });
        fillsByOrder.set(f.order_id as string, arr);
      }
    }

    const rows: TradeOutcomeRow[] = orders.map((o) => {
      const fills = fillsByOrder.get(o.id as string) ?? [];
      const filledQty = fills.reduce((s, f) => s + f.quantity, 0);
      const notional = fills.reduce((s, f) => s + f.quantity * f.price, 0);
      const avgFillPrice = filledQty > 0 ? notional / filledQty : null;
      return {
        id: o.id as string,
        createdAt: o.created_at as string,
        updatedAt: o.updated_at as string,
        submittedAt: (o.submitted_at as string | null) ?? null,
        symbol: o.symbol as string,
        side: o.side as "buy" | "sell",
        quantity: Number(o.quantity),
        orderType: o.order_type as string,
        limitPrice:
          o.limit_price == null ? null : Number(o.limit_price),
        status: o.status as string,
        brokerOrderId: (o.broker_order_id as string | null) ?? null,
        clientOrderId: (o.client_order_id as string | null) ?? null,
        rejectReason: (o.reject_reason as string | null) ?? null,
        instrumentCcy: o.instrument_ccy as string,
        fills,
        filledQty,
        avgFillPrice,
      } satisfies TradeOutcomeRow;
    });

    // Summary counts to drive the header chips.
    const counts = rows.reduce(
      (acc, r) => {
        const bucket =
          r.status === "filled"
            ? "filled"
            : r.status === "partially_filled"
              ? "partial"
              : r.status === "rejected" || r.status === "error"
                ? "failed"
                : r.status === "cancelled"
                  ? "cancelled"
                  : "working";
        acc[bucket] = (acc[bucket] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      rows,
      windowHours: data.sinceHours,
      total: rows.length,
      counts,
    };
  });
