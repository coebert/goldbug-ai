// Cross-run order batching window.
//
// `order-aggregation` already collapses the tickets produced inside ONE tick.
// The remaining commission leak is across ticks: the hourly run emits a £90
// buy in a name, the next run emits another £90 in the same name, and so on.
// Each slice pays the Saxo floor (£3/side + 0.5% stamp on UK single stocks)
// again, so nine £90 slices cost ~9x what one £810 ticket costs.
//
// The cost governor's answer today is to SKIP any buy under the NAV-scaled
// minimum ticket. That protects the book from floor drag but throws the
// signal away entirely. This module adds the middle path: park a sub-minimum
// buy in a batching window and let subsequent signals in the same name
// accumulate against it. Once the accumulated notional clears the minimum
// ticket, the whole thing is released as ONE order — one commission, one
// spread crossing, the same net position.
//
// Rules that keep this safe:
//   - SELLs never batch. Risk reduction is immediate, always.
//   - A parked intent expires after `windowHours` (default 24). A stale buy
//     signal is not worth acting on later.
//   - If the price has moved more than `maxPriceDriftPct` since the intent
//     was parked, the parked leg is dropped: the thesis was priced at a level
//     that no longer exists.
//   - A buy that is already at or above the minimum ticket is released
//     immediately, absorbing any parked quantity in that name.
//
// Pure and I/O-free: the caller supplies the parked rows and the minimum
// ticket, and persists whatever comes back.

import { engineSymbolKey } from "./price-symbol";

export type BatchWindowConfig = {
  /** How long a parked buy stays eligible to be topped up, in hours. */
  windowHours: number;
  /**
   * Maximum price move (fraction) between parking and release before the
   * parked leg is discarded as stale.
   */
  maxPriceDriftPct: number;
};

export const DEFAULT_BATCH_WINDOW: BatchWindowConfig = {
  windowHours: 24,
  maxPriceDriftPct: 0.05,
};

/** A buy intent already parked in the window by an earlier run. */
export type ParkedIntent = {
  id?: string;
  symbol: string;
  quantity: number;
  /** Price at which the parked quantity was last sized. */
  price: number;
  /** Notional in the portfolio's base currency at park time. */
  notionalBase: number;
  conviction?: number | null;
  /** ISO timestamp of when this intent first entered the window. */
  firstSeenAt: string;
};

export type BatchableOrder = {
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  /** Ticket notional in the portfolio's base currency. */
  notionalBase?: number;
  conviction?: number | null;
};

export type BatchRelease<T extends BatchableOrder> = {
  /** The order to route, with quantity grown by any parked slices. */
  order: T;
  /** Quantity contributed by previously parked intents. */
  parkedQuantity: number;
  parkedIds: string[];
  notionalBase: number;
  /** Hours the oldest constituent slice waited. */
  waitedHours: number;
};

export type BatchPark = {
  id?: string;
  symbol: string;
  quantity: number;
  price: number;
  notionalBase: number;
  conviction: number | null;
  firstSeenAt: string;
  expiresAt: string;
  /** Base-currency shortfall still needed before this releases. */
  shortfallBase: number;
};

export type BatchDrop = {
  id?: string;
  symbol: string;
  reason: "expired" | "price_drift";
  notionalBase: number;
};

export type BatchPlan<T extends BatchableOrder> = {
  /** Orders to route this tick (sells, big buys, and released batches). */
  release: Array<BatchRelease<T>>;
  /** Intents to write back into the window. */
  park: BatchPark[];
  /** Parked rows to delete without trading. */
  drop: BatchDrop[];
  /** Parked ids consumed by a release (delete these too). */
  consumedIds: string[];
};

export type PlanBatchInput<T extends BatchableOrder> = {
  incoming: T[];
  parked: ParkedIntent[];
  /** NAV-scaled minimum economic ticket, base currency. */
  minTicketBase: number;
  /** Current time; ISO string or Date. */
  now: Date | string;
  config?: Partial<BatchWindowConfig>;
};

function hoursBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 3_600_000;
}

function isSell(side: string): boolean {
  return String(side).toLowerCase() === "sell";
}

/**
 * Decide which intents trade now and which wait for more signal.
 */
export function planBatchWindow<T extends BatchableOrder>(
  input: PlanBatchInput<T>,
): BatchPlan<T> {
  const cfg: BatchWindowConfig = { ...DEFAULT_BATCH_WINDOW, ...(input.config ?? {}) };
  const now = input.now instanceof Date ? input.now : new Date(input.now);
  const minTicket = Math.max(0, Number(input.minTicketBase) || 0);

  const plan: BatchPlan<T> = { release: [], park: [], drop: [], consumedIds: [] };

  const parkedBySymbol = new Map<string, ParkedIntent>();
  for (const p of input.parked ?? []) {
    const key = engineSymbolKey(p.symbol);
    const ageHours = hoursBetween(now, new Date(p.firstSeenAt));
    if (!(ageHours < cfg.windowHours)) {
      plan.drop.push({
        ...(p.id ? { id: p.id } : {}),
        symbol: p.symbol,
        reason: "expired",
        notionalBase: Number(p.notionalBase) || 0,
      });
      continue;
    }
    parkedBySymbol.set(key, p);
  }

  for (const order of input.incoming ?? []) {
    const key = engineSymbolKey(order.symbol);
    const qty = Number(order.quantity);
    const price = Number(order.price);
    const notional = Math.max(0, Number(order.notionalBase) || 0);

    // Sells and malformed rows bypass the window entirely.
    if (isSell(order.side) || !(qty > 0) || !(price > 0)) {
      plan.release.push({
        order,
        parkedQuantity: 0,
        parkedIds: [],
        notionalBase: notional,
        waitedHours: 0,
      });
      // An exit cancels any parked add in the same name — batching into a
      // position we are simultaneously leaving makes no sense.
      const parked = parkedBySymbol.get(key);
      if (isSell(order.side) && parked) {
        parkedBySymbol.delete(key);
        plan.drop.push({
          ...(parked.id ? { id: parked.id } : {}),
          symbol: parked.symbol,
          reason: "expired",
          notionalBase: Number(parked.notionalBase) || 0,
        });
      }
      continue;
    }

    let parked = parkedBySymbol.get(key);
    parkedBySymbol.delete(key);

    // Drop a parked leg whose price has run away from us.
    if (parked && Number(parked.price) > 0) {
      const drift = Math.abs(price - Number(parked.price)) / Number(parked.price);
      if (drift > cfg.maxPriceDriftPct) {
        plan.drop.push({
          ...(parked.id ? { id: parked.id } : {}),
          symbol: parked.symbol,
          reason: "price_drift",
          notionalBase: Number(parked.notionalBase) || 0,
        });
        parked = undefined;
      }
    }

    const parkedQty = parked ? Math.max(0, Number(parked.quantity) || 0) : 0;
    // Parked quantity is re-priced at today's price: that is what it will
    // actually cost to buy it now.
    const combinedQty = qty + parkedQty;
    const combinedNotional = notional * (combinedQty / qty);

    if (combinedNotional >= minTicket) {
      plan.release.push({
        order: { ...order, quantity: combinedQty },
        parkedQuantity: parkedQty,
        parkedIds: parked?.id ? [parked.id] : [],
        notionalBase: combinedNotional,
        waitedHours: parked ? Math.max(0, hoursBetween(now, new Date(parked.firstSeenAt))) : 0,
      });
      if (parked?.id) plan.consumedIds.push(parked.id);
      continue;
    }

    const firstSeenAt = parked?.firstSeenAt ?? now.toISOString();
    const expiresAt = new Date(
      new Date(firstSeenAt).getTime() + cfg.windowHours * 3_600_000,
    ).toISOString();
    const conviction = Number.isFinite(Number(order.conviction))
      ? Number(order.conviction)
      : (parked?.conviction ?? null);
    plan.park.push({
      ...(parked?.id ? { id: parked.id } : {}),
      symbol: order.symbol,
      quantity: combinedQty,
      price,
      notionalBase: combinedNotional,
      conviction: conviction == null ? null : Number(conviction),
      firstSeenAt,
      expiresAt,
      shortfallBase: Math.max(0, minTicket - combinedNotional),
    });
  }

  // Parked names with no signal this tick simply stay parked; nothing to do.
  return plan;
}
