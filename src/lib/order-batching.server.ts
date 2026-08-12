// Persistence for the cross-run order batching window.
//
// Reads parked buy intents for a portfolio, runs the pure planner, writes the
// result back, and hands the executor the orders that should actually route
// this tick.

import { planBatchWindow, type BatchableOrder, type ParkedIntent, type BatchPlan } from "./order-batching";

type Db = {
  from: (table: string) => any;
};

export type ApplyBatchWindowArgs<T extends BatchableOrder> = {
  db: Db;
  portfolioId: string;
  userId: string;
  orders: T[];
  /** Base-currency notional for each order, keyed `${symbol}:${side}`. */
  notionalBase: (order: T) => number;
  minTicketBase: number;
  windowHours?: number;
  now?: Date;
};

export type ApplyBatchWindowResult<T extends BatchableOrder> = {
  orders: T[];
  parked: BatchPlan<T>["park"];
  dropped: BatchPlan<T>["drop"];
  releasedWithParked: number;
};

export async function applyBatchWindow<T extends BatchableOrder>(
  args: ApplyBatchWindowArgs<T>,
): Promise<ApplyBatchWindowResult<T>> {
  const now = args.now ?? new Date();

  let parked: ParkedIntent[] = [];
  try {
    const { data } = await args.db
      .from("order_batch_queue")
      .select("id, symbol, quantity, price, notional_base, conviction, first_seen_at")
      .eq("portfolio_id", args.portfolioId);
    parked = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r["id"]),
      symbol: String(r["symbol"]),
      quantity: Number(r["quantity"]),
      price: Number(r["price"]),
      notionalBase: Number(r["notional_base"]),
      conviction: r["conviction"] == null ? null : Number(r["conviction"]),
      firstSeenAt: String(r["first_seen_at"]),
    }));
  } catch {
    // No queue available — behave exactly as before batching existed.
    return { orders: args.orders, parked: [], dropped: [], releasedWithParked: 0 };
  }

  const incoming = args.orders.map((o) => ({
    ...o,
    notionalBase: args.notionalBase(o),
  }));

  const plan = planBatchWindow({
    incoming,
    parked,
    minTicketBase: args.minTicketBase,
    now,
    ...(args.windowHours ? { config: { windowHours: args.windowHours } } : {}),
  });

  const deleteIds = [
    ...plan.consumedIds,
    ...plan.drop.map((d) => d.id).filter((x): x is string => Boolean(x)),
  ];
  if (deleteIds.length > 0) {
    try {
      await args.db.from("order_batch_queue").delete().in("id", deleteIds);
    } catch {
      /* best effort — a stale row expires on its own next tick */
    }
  }

  for (const p of plan.park) {
    const row = {
      portfolio_id: args.portfolioId,
      user_id: args.userId,
      symbol: p.symbol,
      side: "buy",
      quantity: p.quantity,
      price: p.price,
      notional_base: p.notionalBase,
      conviction: p.conviction,
      first_seen_at: p.firstSeenAt,
      expires_at: p.expiresAt,
      updated_at: now.toISOString(),
    };
    try {
      if (p.id) {
        await args.db.from("order_batch_queue").update(row).eq("id", p.id);
      } else {
        await args.db.from("order_batch_queue").insert(row);
      }
    } catch {
      /* parking is an optimisation; never block the tick on it */
    }
  }

  return {
    orders: plan.release.map((r) => r.order as unknown as T),
    parked: plan.park,
    dropped: plan.drop,
    releasedWithParked: plan.release.filter((r) => r.parkedQuantity > 0).length,
  };
}
