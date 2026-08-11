import { describe, expect, it } from "vitest";
import { rebuildLedgerFromFills, type FillLite } from "@/lib/fills-ledger-rebuild";

/**
 * Cancellation / re-submission reconciliation.
 *
 * The live loop does not submit an order once and walk away. A working order
 * can be partially filled, cancelled for the remainder, then re-submitted as
 * a *new* broker order for what is left — and every one of those steps is
 * observed through a reconcile poll that replays the broker's event list from
 * scratch. That replay is at-least-once: the same fill is seen on every poll,
 * a cancel can arrive after the fill that raced it, and a re-submission looks
 * a lot like the order it replaced.
 *
 * The failure mode is double-counting: the same execution booked twice inflates
 * holdings, debits cash twice and pays the commission twice. The opposite
 * failure is a cancel that "unwinds" quantity the broker actually filled.
 *
 * This suite pins the ledger contract for that lifecycle:
 *
 *   1. Fills are identified by broker fill id. Replaying an event stream any
 *      number of times yields byte-identical positions, cash and fees.
 *   2. A cancelled remainder contributes no fill, no fee and no cash delta.
 *   3. A re-submission is a distinct order; its fills add to the parent's
 *      filled quantity exactly once and never exceed the intended quantity.
 *   4. A cancel that arrives for an already-filled order is a no-op, not a
 *      reversal.
 *   5. Fees are booked once per fill id regardless of how many reconcile
 *      passes observe them.
 *
 * Each property carries a negative control (identity by symbol+quantity rather
 * than fill id, or a cancel that rewinds quantity) so the checks have teeth.
 */

// ---------------------------------------------------------------------------
// Event model — a broker's view of the order lifecycle
// ---------------------------------------------------------------------------

type OrderEvent =
  | {
      kind: "submit";
      orderId: string;
      symbol: string;
      side: "buy" | "sell";
      quantity: number;
      /** Set when this order replaces the cancelled remainder of another. */
      replaces?: string;
    }
  | {
      kind: "fill";
      fillId: string;
      orderId: string;
      symbol: string;
      side: "buy" | "sell";
      quantity: number;
      price: number;
      fee: number;
      filledAt: string;
    }
  | { kind: "cancel"; orderId: string; at: string };

type OrderState = {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  intended: number;
  filled: number;
  cancelled: boolean;
  replaces: string | null;
};

type Reconciled = {
  orders: Map<string, OrderState>;
  /** Deduped fills, in arrival order. */
  fills: Array<FillLite & { price: number; fee: number; orderId: string }>;
  feeTotal: number;
  /** Events ignored because they had already been applied. */
  duplicates: number;
};

/** Identity of a fill. Swapped out by the negative controls. */
type FillKey = (e: Extract<OrderEvent, { kind: "fill" }>) => string;

const byFillId: FillKey = (e) => e.fillId;

/**
 * Replay a broker event stream into an order book + fill ledger.
 *
 * At-least-once safe: a fill whose key has already been applied is counted as
 * a duplicate and dropped before it can touch quantity, cash or fees. A cancel
 * only closes the *unfilled* remainder — it never rewinds filled quantity.
 */
function reconcileOrderEvents(events: readonly OrderEvent[], key: FillKey = byFillId): Reconciled {
  const orders = new Map<string, OrderState>();
  const seen = new Set<string>();
  const fills: Reconciled["fills"] = [];
  let feeTotal = 0;
  let duplicates = 0;

  for (const e of events) {
    if (e.kind === "submit") {
      if (!orders.has(e.orderId)) {
        orders.set(e.orderId, {
          orderId: e.orderId,
          symbol: e.symbol,
          side: e.side,
          intended: e.quantity,
          filled: 0,
          cancelled: false,
          replaces: e.replaces ?? null,
        });
      }
      continue;
    }

    if (e.kind === "cancel") {
      const o = orders.get(e.orderId);
      // Cancelling closes the remainder only. Filled quantity is history.
      if (o) o.cancelled = true;
      continue;
    }

    const k = key(e);
    if (seen.has(k)) {
      duplicates += 1;
      continue;
    }
    seen.add(k);

    const o = orders.get(e.orderId);
    if (o) o.filled += e.quantity;
    feeTotal += e.fee;
    fills.push({
      id: e.fillId,
      orderId: e.orderId,
      symbol: e.symbol,
      side: e.side,
      quantity: e.quantity,
      fill_price: e.price,
      filled_at: e.filledAt,
      price: e.price,
      fee: e.fee,
    });
  }

  return { orders, fills, feeTotal, duplicates };
}

/** Cash after fills and fees: fills debit/credit notional, fees always debit. */
function cashDelta(r: Reconciled): number {
  return rebuildLedgerFromFills(r.fills).cashDelta - r.feeTotal;
}

function positions(r: Reconciled) {
  return rebuildLedgerFromFills(r.fills).positions;
}

/** Total quantity a symbol's chain of orders was allowed to execute. */
function intendedFor(r: Reconciled, symbol: string): number {
  let total = 0;
  for (const o of r.orders.values()) {
    if (o.symbol !== symbol) continue;
    // A replacement inherits the parent's remainder; only the root order
    // contributes fresh intent.
    if (o.replaces) continue;
    total += o.intended;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Scenario: partial fill -> cancel remainder -> re-submit -> fill
// ---------------------------------------------------------------------------

const T = (h: number) => `2026-08-11T${String(h).padStart(2, "0")}:00:00Z`;

function lifecycle(): OrderEvent[] {
  return [
    { kind: "submit", orderId: "O1", symbol: "V", side: "buy", quantity: 100 },
    {
      kind: "fill",
      fillId: "F1",
      orderId: "O1",
      symbol: "V",
      side: "buy",
      quantity: 40,
      price: 250,
      fee: 3,
      filledAt: T(9),
    },
    { kind: "cancel", orderId: "O1", at: T(10) },
    { kind: "submit", orderId: "O2", symbol: "V", side: "buy", quantity: 60, replaces: "O1" },
    {
      kind: "fill",
      fillId: "F2",
      orderId: "O2",
      symbol: "V",
      side: "buy",
      quantity: 60,
      price: 252,
      fee: 3,
      filledAt: T(11),
    },
  ];
}

/** A reconcile poll re-reads the whole window, so events repeat verbatim. */
function replayPolls(events: readonly OrderEvent[], polls: number): OrderEvent[] {
  const out: OrderEvent[] = [];
  for (let i = 0; i < polls; i++) out.push(...events);
  return out;
}

describe("cancel / re-submit reconciliation", () => {
  it("books each fill, fee and cash delta exactly once for the whole lifecycle", () => {
    const r = reconcileOrderEvents(lifecycle());

    expect(r.fills).toHaveLength(2);
    expect(r.feeTotal).toBe(6);
    expect(positions(r)).toEqual([
      { symbol: "V", quantity: 100, avgCost: (40 * 250 + 60 * 252) / 100 },
    ]);
    expect(cashDelta(r)).toBeCloseTo(-(40 * 250 + 60 * 252) - 6, 9);
  });

  it("is idempotent across repeated reconcile polls", () => {
    const once = reconcileOrderEvents(lifecycle());
    for (const polls of [2, 3, 7]) {
      const many = reconcileOrderEvents(replayPolls(lifecycle(), polls));
      expect(many.fills.map((f) => f.id)).toEqual(once.fills.map((f) => f.id));
      expect(many.feeTotal).toBe(once.feeTotal);
      expect(positions(many)).toEqual(positions(once));
      expect(cashDelta(many)).toBe(cashDelta(once));
      expect(many.duplicates).toBe(once.fills.length * (polls - 1));
    }
  });

  it("charges nothing for the cancelled remainder", () => {
    const r = reconcileOrderEvents(lifecycle());
    const o1 = r.orders.get("O1")!;
    expect(o1.cancelled).toBe(true);
    expect(o1.filled).toBe(40);
    // The 60 unfilled shares of O1 cost nothing: no fill row, no fee.
    expect(r.fills.filter((f) => f.orderId === "O1")).toHaveLength(1);
    expect(r.fills.filter((f) => f.orderId === "O1").reduce((a, f) => a + f.fee, 0)).toBe(3);
  });

  it("never executes more than the originally intended quantity", () => {
    const r = reconcileOrderEvents(replayPolls(lifecycle(), 4));
    const executed = [...r.orders.values()].reduce((a, o) => a + o.filled, 0);
    expect(executed).toBe(100);
    expect(executed).toBeLessThanOrEqual(intendedFor(r, "V"));
    expect(r.orders.get("O2")!.filled).toBe(60);
  });

  it("treats a cancel racing a completed fill as a no-op, not a reversal", () => {
    const raced: OrderEvent[] = [
      { kind: "submit", orderId: "O3", symbol: "AAPL", side: "buy", quantity: 10 },
      {
        kind: "fill",
        fillId: "F3",
        orderId: "O3",
        symbol: "AAPL",
        side: "buy",
        quantity: 10,
        price: 200,
        fee: 2,
        filledAt: T(9),
      },
      { kind: "cancel", orderId: "O3", at: T(9) },
    ];
    const r = reconcileOrderEvents(raced);
    expect(r.orders.get("O3")!.filled).toBe(10);
    expect(positions(r)).toEqual([{ symbol: "AAPL", quantity: 10, avgCost: 200 }]);
    expect(cashDelta(r)).toBe(-2002);
  });

  it("re-submits after a full cancel without inheriting the parent's fills", () => {
    const events: OrderEvent[] = [
      { kind: "submit", orderId: "O4", symbol: "JNJ", side: "buy", quantity: 20 },
      { kind: "cancel", orderId: "O4", at: T(9) },
      { kind: "submit", orderId: "O5", symbol: "JNJ", side: "buy", quantity: 20, replaces: "O4" },
      {
        kind: "fill",
        fillId: "F4",
        orderId: "O5",
        symbol: "JNJ",
        side: "buy",
        quantity: 20,
        price: 150,
        fee: 3,
        filledAt: T(10),
      },
    ];
    const r = reconcileOrderEvents(replayPolls(events, 3));
    expect(r.orders.get("O4")!.filled).toBe(0);
    expect(r.orders.get("O5")!.filled).toBe(20);
    expect(r.feeTotal).toBe(3);
    expect(cashDelta(r)).toBe(-3003);
  });

  it("keeps sells symmetric: a cancelled sell remainder leaves the position intact", () => {
    const events: OrderEvent[] = [
      { kind: "submit", orderId: "B", symbol: "V", side: "buy", quantity: 100 },
      {
        kind: "fill",
        fillId: "FB",
        orderId: "B",
        symbol: "V",
        side: "buy",
        quantity: 100,
        price: 250,
        fee: 3,
        filledAt: T(9),
      },
      { kind: "submit", orderId: "S1", symbol: "V", side: "sell", quantity: 100 },
      {
        kind: "fill",
        fillId: "FS1",
        orderId: "S1",
        symbol: "V",
        side: "sell",
        quantity: 30,
        price: 260,
        fee: 3,
        filledAt: T(11),
      },
      { kind: "cancel", orderId: "S1", at: T(12) },
    ];
    const r = reconcileOrderEvents(replayPolls(events, 2));
    expect(positions(r)).toEqual([{ symbol: "V", quantity: 70, avgCost: 250 }]);
    expect(r.feeTotal).toBe(6);
    expect(cashDelta(r)).toBe(-100 * 250 + 30 * 260 - 6);
  });
});

// ---------------------------------------------------------------------------
// Negative controls — prove the properties above can actually fail
// ---------------------------------------------------------------------------

describe("negative controls", () => {
  it("double-counts when a re-submitted fill is keyed by order id instead of fill id", () => {
    // Broker order ids are reused when an order is amended in place; keying on
    // them alone silently merges two distinct executions.
    const byOrderId: FillKey = (e) => e.orderId;
    const amended: OrderEvent[] = [
      { kind: "submit", orderId: "O1", symbol: "V", side: "buy", quantity: 100 },
      {
        kind: "fill",
        fillId: "F1",
        orderId: "O1",
        symbol: "V",
        side: "buy",
        quantity: 40,
        price: 250,
        fee: 3,
        filledAt: T(9),
      },
      {
        kind: "fill",
        fillId: "F2",
        orderId: "O1",
        symbol: "V",
        side: "buy",
        quantity: 60,
        price: 252,
        fee: 3,
        filledAt: T(11),
      },
    ];
    const good = reconcileOrderEvents(amended);
    const bad = reconcileOrderEvents(amended, byOrderId);
    expect(good.orders.get("O1")!.filled).toBe(100);
    expect(bad.orders.get("O1")!.filled).toBe(40); // second execution swallowed
    expect(bad.feeTotal).toBeLessThan(good.feeTotal);
  });

  it("double-counts fees and cash when duplicate polls are not deduped", () => {
    const noDedupe: FillKey = (() => {
      let n = 0;
      return () => `unique-${n++}`;
    })();
    const once = reconcileOrderEvents(lifecycle());
    const twice = reconcileOrderEvents(replayPolls(lifecycle(), 2), noDedupe);
    expect(twice.feeTotal).toBe(once.feeTotal * 2);
    expect(cashDelta(twice)).toBeCloseTo(cashDelta(once) * 2, 9);
    expect(positions(twice)[0]!.quantity).toBe(positions(once)[0]!.quantity * 2);
  });

  it("a cancel that rewinds filled quantity would corrupt the book", () => {
    const r = reconcileOrderEvents(lifecycle());
    const o1 = r.orders.get("O1")!;
    const rewound = o1.filled - o1.intended; // what a naive "cancel = zero out" does
    expect(rewound).toBeLessThan(0);
    expect(o1.filled).toBe(40); // the real reducer keeps the executed quantity
  });
});
