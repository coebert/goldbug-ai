import { describe, expect, it } from "vitest";
import {
  reconcileTradeLegs,
  type ExecutedOrder,
  type IntendedLeg,
} from "@/lib/trade-leg-reconciliation";
import { intendedLegsFromRaw } from "@/lib/trade-leg-reconciliation.server";

const T0 = Date.parse("2026-08-21T10:00:00Z");
const NOW = T0 + 5 * 60_000;

function leg(over: Partial<IntendedLeg> = {}): IntendedLeg {
  return {
    decisionId: "d1",
    symbol: "AAPL",
    side: "buy",
    quantity: 10,
    price: 100,
    engineRejection: null,
    ...over,
  };
}

function order(over: Partial<ExecutedOrder> = {}): ExecutedOrder {
  return {
    id: "o1",
    decisionId: "d1",
    symbol: "AAPL:xnas",
    side: "buy",
    quantity: 10,
    status: "filled",
    rejectReason: null,
    brokerOrderId: "B1",
    createdAt: new Date(T0).toISOString(),
    filledQuantity: 10,
    avgFillPrice: 100,
    ...over,
  };
}

describe("reconcileTradeLegs", () => {
  it("passes a clean intent that executed as planned", () => {
    const r = reconcileTradeLegs({ intended: [leg()], orders: [order()], nowMs: NOW });
    expect(r.discrepancies).toEqual([]);
    expect(r.summary).toMatchObject({ intendedLegs: 1, matchedLegs: 1, droppedLegs: 0 });
  });

  it("flags a dropped leg when nothing was routed and no veto explains it", () => {
    const r = reconcileTradeLegs({ intended: [leg()], orders: [], nowMs: NOW });
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]!.code).toBe("dropped_leg");
    expect(r.discrepancies[0]!.severity).toBe("critical");
    expect(r.summary.unexecutedValue).toBe(1000);
  });

  it("does not flag legs the engine deliberately vetoed", () => {
    const r = reconcileTradeLegs({
      intended: [leg({ engineRejection: "cash floor" })],
      orders: [],
      nowMs: NOW,
    });
    expect(r.discrepancies).toEqual([]);
  });

  it("flags a side mismatch", () => {
    const r = reconcileTradeLegs({
      intended: [leg()],
      orders: [order({ side: "sell" })],
      nowMs: NOW,
    });
    expect(r.discrepancies.map((d) => d.code)).toContain("side_mismatch");
  });

  it("flags a short fill on a terminal filled order", () => {
    const r = reconcileTradeLegs({
      intended: [leg()],
      orders: [order({ filledQuantity: 4 })],
      nowMs: NOW,
    });
    const d = r.discrepancies.find((x) => x.code === "quantity_short");
    expect(d?.executedQuantity).toBe(4);
    expect(r.summary.mismatchedLegs).toBe(1);
  });

  it("tolerates rounding-sized quantity gaps", () => {
    const r = reconcileTradeLegs({
      intended: [leg()],
      orders: [order({ filledQuantity: 9.8 })],
      nowMs: NOW,
    });
    expect(r.discrepancies).toEqual([]);
  });

  it("flags an over-fill", () => {
    const r = reconcileTradeLegs({
      intended: [leg()],
      orders: [order({ filledQuantity: 20, quantity: 20 })],
      nowMs: NOW,
    });
    expect(r.discrepancies.map((d) => d.code)).toContain("quantity_over");
  });

  it("flags adverse price deviation only in the adverse direction", () => {
    const bad = reconcileTradeLegs({
      intended: [leg()],
      orders: [order({ avgFillPrice: 103 })],
      nowMs: NOW,
    });
    expect(bad.discrepancies.map((d) => d.code)).toContain("price_deviation");
    expect(bad.discrepancies[0]!.priceDeviationBps).toBeCloseTo(300, 0);

    const good = reconcileTradeLegs({
      intended: [leg()],
      orders: [order({ avgFillPrice: 97 })],
      nowMs: NOW,
    });
    expect(good.discrepancies).toEqual([]);
  });

  it("flags an order still pending well past the tick", () => {
    const r = reconcileTradeLegs({
      intended: [leg()],
      orders: [order({ status: "working", filledQuantity: 0, avgFillPrice: null })],
      nowMs: T0 + 60 * 60_000,
    });
    expect(r.discrepancies.map((d) => d.code)).toContain("stale_pending");
  });

  it("does not flag a young pending order", () => {
    const r = reconcileTradeLegs({
      intended: [leg()],
      orders: [order({ status: "working", filledQuantity: 0, avgFillPrice: null })],
      nowMs: NOW,
    });
    expect(r.discrepancies).toEqual([]);
  });

  it("treats a reasoned broker rejection as explained, but a silent one as dropped", () => {
    const explained = reconcileTradeLegs({
      intended: [leg()],
      orders: [
        order({ status: "rejected", filledQuantity: 0, avgFillPrice: null, rejectReason: "not enough funds" }),
      ],
      nowMs: NOW,
    });
    expect(explained.discrepancies).toEqual([]);

    const silent = reconcileTradeLegs({
      intended: [leg()],
      orders: [order({ status: "rejected", filledQuantity: 0, avgFillPrice: null })],
      nowMs: NOW,
    });
    expect(silent.discrepancies.map((d) => d.code)).toEqual(["dropped_leg"]);
  });

  it("flags a live broker order with no intended counterpart", () => {
    const r = reconcileTradeLegs({
      intended: [],
      orders: [order({ id: "o9", status: "working", filledQuantity: 0, avgFillPrice: null })],
      nowMs: NOW,
    });
    expect(r.discrepancies.map((d) => d.code)).toEqual(["phantom_leg"]);
    expect(r.summary.phantomLegs).toBe(1);
  });

  it("does not treat a dead unmatched order as a phantom", () => {
    const r = reconcileTradeLegs({
      intended: [],
      orders: [order({ status: "cancelled", filledQuantity: 0, avgFillPrice: null })],
      nowMs: NOW,
    });
    expect(r.discrepancies).toEqual([]);
  });

  it("gives every discrepancy a stable dedupe key", () => {
    const a = reconcileTradeLegs({ intended: [leg()], orders: [], nowMs: NOW });
    const b = reconcileTradeLegs({ intended: [leg()], orders: [], nowMs: NOW + 60_000 });
    expect(a.discrepancies[0]!.key).toBe(b.discrepancies[0]!.key);
  });

  it("pairs multiple legs in the same symbol without double-consuming orders", () => {
    const r = reconcileTradeLegs({
      intended: [leg(), leg({ decisionId: "d1", quantity: 5 })],
      orders: [order(), order({ id: "o2", quantity: 5, filledQuantity: 5 })],
      nowMs: NOW,
    });
    expect(r.discrepancies).toEqual([]);
    expect(r.summary.matchedLegs).toBe(2);
  });
});

describe("intendedLegsFromRaw", () => {
  it("prefers the post-guardrail attempt list and keeps veto text", () => {
    const legs = intendedLegsFromRaw("d7", {
      orders: [{ symbol: "OLD", side: "buy", quantity: 1 }],
      executed: [
        { symbol: "AAPL", side: "buy", quantity: 3, price: 200 },
        { symbol: "MKS.L", side: "sell", quantity: 100, rejected: "cooldown" },
      ],
    });
    expect(legs.map((l) => l.symbol)).toEqual(["AAPL", "MKS.L"]);
    expect(legs[1]!.engineRejection).toBe("cooldown");
    expect(legs[0]!.price).toBe(200);
  });

  it("drops malformed legs", () => {
    const legs = intendedLegsFromRaw("d8", {
      orders: [{ symbol: "", quantity: 5 }, { symbol: "AAPL", quantity: 0 }],
    });
    expect(legs).toEqual([]);
  });
});
