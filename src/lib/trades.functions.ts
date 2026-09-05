// Trades dashboard: aggregates live orders across all portfolios with their
// fills and matching current holding, so each order's lifecycle can be
// verified against its position impact at a glance.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type TradeRow = {
  order: {
    id: string;
    portfolio_id: string;
    symbol: string;
    side: string;
    quantity: number;
    order_type: string;
    limit_price: number | null;
    status: string;
    reject_reason: string | null;
    broker: string;
    broker_order_id: string | null;
    client_order_id: string | null;
    submitted_at: string | null;
    created_at: string;
    updated_at: string;
  };
  portfolio: { id: string; name: string; mode: string } | null;
  fills: Array<{
    id: string;
    quantity: number;
    fill_price: number;
    fee: number;
    commission: number;
    exchangeFee: number;
    tax: number;
    otherFee: number;
    feeSource: string | null;
    currency: string;
    filled_at: string;
    broker_fill_id: string | null;
  }>;
  /** Broker charges on this order, split by kind. */
  charges: {
    total: number;
    commission: number;
    exchange: number;
    tax: number;
    other: number;
    /** True when at least one fill carries the broker's invoiced figures. */
    invoiced: boolean;
    currency: string;
  };
  filledQty: number;
  avgFillPrice: number | null;
  notional: number | null;
  holding: {
    quantity: number;
    avg_cost: number;
    updated_at: string;
  } | null;
};

export const getTradesDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { limit?: number; portfolioId?: string | null; status?: string | null }) =>
    z.object({
      limit: z.number().int().positive().max(500).optional(),
      portfolioId: z.string().uuid().nullable().optional(),
      status: z.string().max(40).nullable().optional(),
    }).parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const limit = data.limit ?? 100;

    let q = supabase.from("live_orders")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (data.portfolioId) q = q.eq("portfolio_id", data.portfolioId);
    if (data.status) q = q.eq("status", data.status);

    const ordersRes = await q;
    if (ordersRes.error) throw new Error(ordersRes.error.message);
    const orders = ordersRes.data ?? [];

    const orderIds = orders.map(o => o.id);
    const portfolioIds = Array.from(new Set(orders.map(o => o.portfolio_id)));
    const symbolByPortfolio = new Set(
      orders.map(o => `${o.portfolio_id}::${o.symbol}`)
    );

    const [fillsRes, portfoliosRes, holdingsRes] = await Promise.all([
      orderIds.length
        ? supabase.from("live_fills").select("*").in("order_id", orderIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
      portfolioIds.length
        ? supabase.from("portfolios").select("id, name, mode").in("id", portfolioIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string; mode: string }>, error: null }),
      portfolioIds.length
        ? supabase.from("holdings")
            .select("portfolio_id, symbol, quantity, avg_cost, updated_at")
            .in("portfolio_id", portfolioIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    ]);

    type FillRow = {
      id: string; order_id: string; portfolio_id: string; quantity: number;
      fill_price: number; fee: number; currency: string; filled_at: string;
      broker_fill_id: string | null;
      fee_commission: number | null; fee_exchange: number | null;
      fee_tax: number | null; fee_other: number | null; fee_source: string | null;
    };
    type HoldingRow = {
      portfolio_id: string; symbol: string; quantity: number; avg_cost: number; updated_at: string;
    };
    const fills = (fillsRes.data ?? []) as unknown as FillRow[];
    const portfolios = (portfoliosRes.data ?? []) as Array<{ id: string; name: string; mode: string }>;
    const holdings = ((holdingsRes.data ?? []) as unknown as HoldingRow[]).filter(h =>
      symbolByPortfolio.has(`${h.portfolio_id}::${h.symbol}`)
    );


    const portfolioById = new Map(portfolios.map(p => [p.id, p]));
    const fillsByOrder = new Map<string, FillRow[]>();
    for (const f of fills) {
      const arr = fillsByOrder.get(f.order_id) ?? [];
      arr.push(f);
      fillsByOrder.set(f.order_id, arr);
    }

    const holdingByKey = new Map(
      holdings.map(h => [`${h.portfolio_id}::${h.symbol}`, h])
    );

    // Summary metrics
    const summary = {
      total: orders.length,
      filled: 0,
      partial: 0,
      submitted: 0,
      rejected: 0,
      errored: 0,
      skipped: 0,
      other: 0,
    };

    const rows: TradeRow[] = orders.map((o) => {
      const orderFills = (fillsByOrder.get(o.id) ?? []).sort(
        (a, b) => new Date(a.filled_at).getTime() - new Date(b.filled_at).getTime()
      );
      const filledQty = orderFills.reduce((s, f) => s + Number(f.quantity ?? 0), 0);
      const notionalSum = orderFills.reduce(
        (s, f) => s + Number(f.quantity ?? 0) * Number(f.fill_price ?? 0), 0
      );
      const avgFillPrice = filledQty > 0 ? notionalSum / filledQty : null;
      const holding = holdingByKey.get(`${o.portfolio_id}::${o.symbol}`) ?? null;

      // Broker charges: prefer the invoiced split when the charge report has
      // been matched to the fill, otherwise fall back to the booked `fee`.
      const sumFee = (pick: (f: FillRow) => number | null) =>
        orderFills.reduce((s, f) => s + Number(pick(f) ?? 0), 0);
      const commission = sumFee((f) => f.fee_commission);
      const exchange = sumFee((f) => f.fee_exchange);
      const tax = sumFee((f) => f.fee_tax);
      const otherSplit = sumFee((f) => f.fee_other);
      const bookedFee = sumFee((f) => f.fee);
      const splitTotal = commission + exchange + tax + otherSplit;
      const invoiced = orderFills.some(
        (f) => (f.fee_source ?? "") !== "" && (f.fee_source ?? "") !== "modelled",
      );
      const charges = {
        total: splitTotal > 0 ? splitTotal : bookedFee,
        commission,
        exchange,
        tax,
        // Anything booked but not itemised still has to show up somewhere.
        other:
          splitTotal > 0
            ? otherSplit
            : Math.max(0, bookedFee - commission - exchange - tax),
        invoiced,
        currency: orderFills[0]?.currency ?? "",
      };

      const status = (o.status ?? "").toLowerCase();
      if (status === "filled") summary.filled++;
      else if (status === "partial" || status === "partially_filled") summary.partial++;
      else if (status === "submitted" || status === "accepted" || status === "working") summary.submitted++;
      else if (status === "rejected") summary.rejected++;
      else if (status === "error" || status === "errored") summary.errored++;
      else if (status === "skipped") summary.skipped++;
      else summary.other++;

      return {
        order: {
          id: o.id,
          portfolio_id: o.portfolio_id,
          symbol: o.symbol,
          side: o.side,
          quantity: Number(o.quantity ?? 0),
          order_type: o.order_type,
          limit_price: o.limit_price != null ? Number(o.limit_price) : null,
          status: o.status,
          reject_reason: o.reject_reason,
          broker: o.broker,
          broker_order_id: o.broker_order_id,
          client_order_id: o.client_order_id,
          submitted_at: o.submitted_at,
          created_at: o.created_at,
          updated_at: o.updated_at,
        },
        portfolio: portfolioById.get(o.portfolio_id) ?? null,
        fills: orderFills.map(f => ({
          id: f.id,
          quantity: Number(f.quantity ?? 0),
          fill_price: Number(f.fill_price ?? 0),
          fee: Number(f.fee ?? 0),
          commission: Number(f.fee_commission ?? 0),
          exchangeFee: Number(f.fee_exchange ?? 0),
          tax: Number(f.fee_tax ?? 0),
          otherFee: Number(f.fee_other ?? 0),
          feeSource: f.fee_source ?? null,
          currency: f.currency,
          filled_at: f.filled_at,
          broker_fill_id: f.broker_fill_id,
        })),
        charges,
        filledQty,
        avgFillPrice,
        notional: filledQty > 0 ? notionalSum : null,
        holding: holding
          ? {
              quantity: Number(holding.quantity ?? 0),
              avg_cost: Number(holding.avg_cost ?? 0),
              updated_at: holding.updated_at,
            }
          : null,
      };
    });

    const portfolioOptions = portfolios
      .map(p => ({ id: p.id, name: p.name, mode: p.mode }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { rows, summary, portfolioOptions };
  });
