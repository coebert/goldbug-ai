// End-to-end integration suite for PARTIAL FILLS.
//
// A partial fill is the one execution outcome that can silently leave the book
// in a state nobody planned: the intent said "sell 1,000 MKS.L", the broker
// filled 380, and unless something notices, the remaining 620 stays on the
// book as inventory the engine believes it has already exited. Every incident
// of a "sold" position still bleeding traced back to exactly that.
//
// The suite composes the real modules a live tick runs, with no Supabase and
// no Saxo HTTP client:
//
//   aggregateOrders        (src/lib/order-aggregation.ts)
//   reconcileTradeLegs     (src/lib/trade-leg-reconciliation.ts)
//
// and asserts three properties across a two-tick lifecycle:
//
//   1. Netting is residual-aware — a partially-filled exit that comes back as
//      a follow-up ticket must route at the *residual* size, and must never be
//      cancelled by an opposing buy signal.
//   2. Dropped legs and part-filled legs are distinguishable — a leg that
//      never reached the broker is `dropped_leg` (critical); a leg that
//      reached it and part-filled is `quantity_short`/`stale_pending`, and its
//      unexecuted notional is always accounted for.
//   3. An adverse average fill price on a partial fill is reported but never
//      suppresses the residual — a bad print must not become a reason to strand
//      the rest of the position.

import { describe, expect, it } from "vitest";
import { aggregateOrders } from "@/lib/order-aggregation";
import {
  reconcileTradeLegs,
  DEFAULT_LEG_TOLERANCES,
  type ExecutedOrder,
  type IntendedLeg,
} from "@/lib/trade-leg-reconciliation";

const T0 = Date.parse("2026-08-21T10:00:00Z");
const MIN = 60_000;

function leg(over: Partial<IntendedLeg> & Pick<IntendedLeg, "symbol" | "side" | "quantity">): IntendedLeg {
  return {
    decisionId: `dec-${over.symbol}-${over.side}`,
    price: 100,
    engineRejection: null,
    ...over,
  };
}

function order(over: Partial<ExecutedOrder> & Pick<ExecutedOrder, "id" | "symbol" | "side" | "quantity">): ExecutedOrder {
  return {
    decisionId: `dec-${over.symbol}-${over.side}`,
    status: "filled",
    rejectReason: null,
    brokerOrderId: `saxo-${over.id}`,
    createdAt: new Date(T0).toISOString(),
    filledQuantity: over.quantity,
    avgFillPrice: 100,
    ...over,
  };
}

/** What the executor must still own after a tick: intent minus what filled. */
function residualQuantity(intended: IntendedLeg, executed: ExecutedOrder | null): number {
  return Math.max(0, intended.quantity - Number(executed?.filledQuantity ?? 0));
}

// -------------------------------------------------- residual-aware netting

describe("partial fills → netting of the residual", () => {
  it("routes the residual exit at the unfilled size, not the original size", () => {
    const intent = leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 });
    const partial = order({
      id: "o1",
      symbol: "MKS.L",
      side: "sell",
      quantity: 1_000,
      filledQuantity: 380,
      status: "filled",
      avgFillPrice: 199,
    });

    const residual = residualQuantity(intent, partial);
    expect(residual).toBe(620);

    // Next tick re-issues the remainder. It must survive aggregation intact.
    const agg = aggregateOrders([
      { symbol: "MKS.L", side: "sell", quantity: residual, price: 199 },
    ]);
    expect(agg.orders).toHaveLength(1);
    expect(agg.orders[0]!.quantity).toBe(620);
  });

  it("does not let a fresh buy signal cancel the residual of a part-filled exit", () => {
    // The exact shape of the bleeding-position incident: an exit half-fills,
    // and on the next tick momentum fires a buy in the same name.
    const agg = aggregateOrders([
      { symbol: "MKS.L", side: "buy", quantity: 900, price: 201 },
      { symbol: "MKS.L", side: "sell", quantity: 620, price: 199 },
    ]);
    expect(agg.orders.map((o) => [o.side, o.quantity])).toEqual([["sell", 620]]);
  });

  it("merges two residual slices of the same exit into one commissionable ticket", () => {
    const agg = aggregateOrders([
      { symbol: "VMID.L", side: "sell", quantity: 40, price: 30 },
      { symbol: "VMID.L", side: "sell", quantity: 60, price: 32 },
    ]);
    expect(agg.orders).toHaveLength(1);
    expect(agg.orders[0]!.quantity).toBe(100);
    expect(agg.orders[0]!.price).toBeCloseTo((40 * 30 + 60 * 32) / 100, 9);
    expect(agg.ticketsSaved).toBe(1);
  });

  it("keeps residuals in different symbols independent", () => {
    const agg = aggregateOrders([
      { symbol: "MKS.L", side: "sell", quantity: 620, price: 199 },
      { symbol: "AAPL:xnas", side: "sell", quantity: 3, price: 230 },
      { symbol: "AAPL:xnas", side: "buy", quantity: 10, price: 231 },
    ]);
    const bySymbol = Object.fromEntries(agg.orders.map((o) => [o.symbol, [o.side, o.quantity]]));
    expect(bySymbol["MKS.L"]).toEqual(["sell", 620]);
    // Exit still wins per-symbol; the buy in AAPL is dropped, MKS is untouched.
    expect(bySymbol["AAPL:xnas"]).toEqual(["sell", 3]);
  });
});

// ------------------------------------------- part-fill vs dropped-leg split

describe("partial fills → reconciliation classification", () => {
  it("flags a part-filled 'filled' order as quantity_short with the unexecuted notional", () => {
    const res = reconcileTradeLegs({
      intended: [leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 })],
      orders: [
        order({
          id: "o1",
          symbol: "MKS.L",
          side: "sell",
          quantity: 1_000,
          filledQuantity: 380,
          avgFillPrice: 200,
        }),
      ],
      nowMs: T0 + MIN,
    });

    const short = res.discrepancies.filter((d) => d.code === "quantity_short");
    expect(short).toHaveLength(1);
    expect(short[0]!.executedQuantity).toBe(380);
    expect(short[0]!.intendedQuantity).toBe(1_000);
    // 620 shares × 200 — the inventory still on the book.
    expect(res.summary.unexecutedValue).toBe(124_000);
    expect(res.summary.droppedLegs).toBe(0);
    expect(res.summary.mismatchedLegs).toBe(1);
  });

  it("distinguishes a dropped leg (never routed) from a part-filled one", () => {
    const res = reconcileTradeLegs({
      intended: [
        leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 }),
        leg({ symbol: "VMID.L", side: "sell", quantity: 100, price: 30 }),
      ],
      orders: [
        order({
          id: "o1",
          symbol: "MKS.L",
          side: "sell",
          quantity: 1_000,
          filledQuantity: 380,
          avgFillPrice: 200,
        }),
      ],
      nowMs: T0 + MIN,
    });

    const codes = res.discrepancies.map((d) => d.code).sort();
    expect(codes).toEqual(["dropped_leg", "quantity_short"]);
    const droppedLeg = res.discrepancies.find((d) => d.code === "dropped_leg")!;
    expect(droppedLeg.symbol).toBe("VMID.L");
    expect(droppedLeg.severity).toBe("critical");
    expect(res.summary.droppedLegs).toBe(1);
    // Both stranded amounts are counted: 620×200 + 100×30.
    expect(res.summary.unexecutedValue).toBe(124_000 + 3_000);
  });

  it("treats a still-working partial as stale_pending once it ages past tolerance", () => {
    const working = order({
      id: "o1",
      symbol: "MKS.L",
      side: "sell",
      quantity: 1_000,
      filledQuantity: 380,
      status: "working",
      avgFillPrice: 200,
    });

    const fresh = reconcileTradeLegs({
      intended: [leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 })],
      orders: [working],
      nowMs: T0 + 5 * MIN,
    });
    // Still inside the window: a partial in flight is not yet an incident.
    expect(fresh.discrepancies).toEqual([]);
    expect(fresh.summary.matchedLegs).toBe(1);

    const aged = reconcileTradeLegs({
      intended: [leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 })],
      orders: [working],
      nowMs: T0 + (DEFAULT_LEG_TOLERANCES.stalePendingMinutes + 1) * MIN,
    });
    expect(aged.discrepancies.map((d) => d.code)).toEqual(["stale_pending"]);
    expect(aged.discrepancies[0]!.executedQuantity).toBe(380);
    expect(aged.summary.unexecutedValue).toBe(124_000);
  });

  it("does not flag a partial inside the quantity tolerance (lot rounding)", () => {
    const res = reconcileTradeLegs({
      intended: [leg({ symbol: "VMID.L", side: "buy", quantity: 100, price: 30 })],
      orders: [
        order({ id: "o1", symbol: "VMID.L", side: "buy", quantity: 100, filledQuantity: 98, avgFillPrice: 30 }),
      ],
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies).toEqual([]);
    expect(res.summary.matchedLegs).toBe(1);
    expect(res.summary.unexecutedValue).toBe(0);
  });

  it("flags a cancelled part-fill with no reason as a dropped leg carrying the residual", () => {
    const res = reconcileTradeLegs({
      intended: [leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 })],
      orders: [
        order({
          id: "o1",
          symbol: "MKS.L",
          side: "sell",
          quantity: 1_000,
          filledQuantity: 380,
          status: "cancelled",
          rejectReason: null,
          avgFillPrice: 200,
        }),
      ],
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies.map((d) => d.code)).toEqual(["dropped_leg"]);
    expect(res.summary.unexecutedValue).toBe(124_000);
  });

  it("pairs a broker-native symbol partial with the universe-symbol intent", () => {
    const res = reconcileTradeLegs({
      intended: [leg({ symbol: "AAPL", side: "sell", quantity: 10, price: 230 })],
      orders: [
        order({
          id: "o1",
          symbol: "AAPL:xnas",
          side: "sell",
          quantity: 10,
          filledQuantity: 4,
          avgFillPrice: 230,
        }),
      ],
      nowMs: T0 + MIN,
    });
    // Regression: a symbol-keying miss reported this as dropped + phantom and
    // hid the fact that 6 shares were still held.
    expect(res.discrepancies.map((d) => d.code)).toEqual(["quantity_short"]);
    expect(res.summary.phantomLegs).toBe(0);
    expect(res.summary.unexecutedValue).toBe(6 * 230);
  });
});

// --------------------------------------------------- adverse fill pricing

describe("partial fills → adverse fill price handling", () => {
  it("reports an adverse average print on a partial without hiding the shortfall", () => {
    const res = reconcileTradeLegs({
      intended: [leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 })],
      orders: [
        order({
          id: "o1",
          symbol: "MKS.L",
          side: "sell",
          quantity: 1_000,
          filledQuantity: 380,
          // Sold 3% below the intended price — clearly past the 150bps gate.
          avgFillPrice: 194,
        }),
      ],
      nowMs: T0 + MIN,
    });

    const codes = res.discrepancies.map((d) => d.code).sort();
    expect(codes).toEqual(["price_deviation", "quantity_short"]);
    const dev = res.discrepancies.find((d) => d.code === "price_deviation")!;
    expect(dev.priceDeviationBps).toBeCloseTo(-300, 6);
    expect(dev.severity).toBe("warning");
    // The residual is still fully accounted for at the intended price.
    expect(res.summary.unexecutedValue).toBe(124_000);
    // One leg, flagged once, regardless of how many codes it produced.
    expect(res.summary.mismatchedLegs).toBe(1);
  });

  it("treats a favourable partial print as no price incident", () => {
    const res = reconcileTradeLegs({
      intended: [leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 })],
      orders: [
        order({ id: "o1", symbol: "MKS.L", side: "sell", quantity: 1_000, filledQuantity: 380, avgFillPrice: 206 }),
      ],
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies.map((d) => d.code)).toEqual(["quantity_short"]);
  });

  it("flags paying up on a partially-filled buy", () => {
    const res = reconcileTradeLegs({
      intended: [leg({ symbol: "AAPL", side: "buy", quantity: 100, price: 230 })],
      orders: [
        order({ id: "o1", symbol: "AAPL", side: "buy", quantity: 100, filledQuantity: 40, avgFillPrice: 237 }),
      ],
      nowMs: T0 + MIN,
    });
    const dev = res.discrepancies.find((d) => d.code === "price_deviation")!;
    expect(dev).toBeDefined();
    expect(dev.priceDeviationBps).toBeGreaterThan(150);
  });

  it("an adverse print never removes the residual exit from the next tick", () => {
    const intent = leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 });
    const bad = order({
      id: "o1",
      symbol: "MKS.L",
      side: "sell",
      quantity: 1_000,
      filledQuantity: 380,
      avgFillPrice: 190,
    });
    const residual = residualQuantity(intent, bad);
    const agg = aggregateOrders([
      { symbol: "MKS.L", side: "sell", quantity: residual, price: 190 },
      { symbol: "MKS.L", side: "buy", quantity: 500, price: 191 },
    ]);
    expect(agg.orders.map((o) => [o.side, o.quantity])).toEqual([["sell", 620]]);
  });
});

// ------------------------------------------------ full lifecycle: no strand

describe("partial fills → two-tick lifecycle leaves no stranded inventory", () => {
  it("completes the exit across two ticks and reconciles clean at the end", () => {
    const intent = leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 });

    // Tick 1 — 380 of 1,000 fills.
    const tick1Order = order({
      id: "o1",
      symbol: "MKS.L",
      side: "sell",
      quantity: 1_000,
      filledQuantity: 380,
      avgFillPrice: 200,
    });
    const recon1 = reconcileTradeLegs({
      intended: [intent],
      orders: [tick1Order],
      nowMs: T0 + MIN,
    });
    expect(recon1.summary.unexecutedValue).toBeGreaterThan(0);

    // Tick 2 — the residual is re-issued and fills in full.
    const residual = residualQuantity(intent, tick1Order);
    const followUp = leg({
      decisionId: "dec-MKS.L-sell-resid",
      symbol: "MKS.L",
      side: "sell",
      quantity: residual,
      price: 199,
    });
    const recon2 = reconcileTradeLegs({
      intended: [followUp],
      orders: [
        order({
          id: "o2",
          decisionId: "dec-MKS.L-sell-resid",
          symbol: "MKS.L",
          side: "sell",
          quantity: residual,
          filledQuantity: residual,
          avgFillPrice: 199,
        }),
      ],
      nowMs: T0 + 20 * MIN,
    });

    expect(recon2.discrepancies).toEqual([]);
    expect(recon2.summary.unexecutedValue).toBe(0);
    expect(recon2.summary.matchedLegs).toBe(1);

    // Position is flat: everything intended eventually executed.
    const totalFilled = 380 + residual;
    expect(totalFilled).toBe(intent.quantity);
  });

  it("keeps reporting the shortfall while the residual is never re-issued", () => {
    const intent = leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 });
    const partial = order({
      id: "o1",
      symbol: "MKS.L",
      side: "sell",
      quantity: 1_000,
      filledQuantity: 380,
      avgFillPrice: 200,
    });
    for (const nowMs of [T0 + MIN, T0 + 60 * MIN, T0 + 24 * 60 * MIN]) {
      const res = reconcileTradeLegs({ intended: [intent], orders: [partial], nowMs });
      expect(res.discrepancies.map((d) => d.code)).toEqual(["quantity_short"]);
      expect(res.summary.unexecutedValue).toBe(124_000);
    }
  });

  it("an unmatched broker fill in the same symbol still surfaces as a phantom leg", () => {
    const res = reconcileTradeLegs({
      intended: [leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 })],
      orders: [
        order({ id: "o1", symbol: "MKS.L", side: "sell", quantity: 1_000, filledQuantity: 380, avgFillPrice: 200 }),
        order({ id: "o2", symbol: "MKS.L", side: "buy", quantity: 200, filledQuantity: 200, avgFillPrice: 201 }),
      ],
      nowMs: T0 + MIN,
    });
    const phantom = res.discrepancies.find((d) => d.code === "phantom_leg");
    expect(phantom).toBeDefined();
    expect(phantom!.side).toBe("buy");
    expect(phantom!.severity).toBe("critical");
    expect(res.summary.phantomLegs).toBe(1);
  });

  it("deduplication keys stay stable across repeat ticks for the same partial", () => {
    const intent = leg({ symbol: "MKS.L", side: "sell", quantity: 1_000, price: 200 });
    const partial = order({
      id: "o1",
      symbol: "MKS.L",
      side: "sell",
      quantity: 1_000,
      filledQuantity: 380,
      avgFillPrice: 194,
    });
    const a = reconcileTradeLegs({ intended: [intent], orders: [partial], nowMs: T0 + MIN });
    const b = reconcileTradeLegs({ intended: [intent], orders: [partial], nowMs: T0 + 9 * MIN });
    expect(a.discrepancies.map((d) => d.key).sort()).toEqual(
      b.discrepancies.map((d) => d.key).sort(),
    );
  });
});
