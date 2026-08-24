import { describe, it, expect } from "vitest";
import {
  classifyOrphanOrders,
  hasBlockingOrphans,
  type BrokerWorkingOrder,
  type LocalOpenOrder,
} from "@/lib/orphan-order-sweep";

const NOW = Date.parse("2026-08-24T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function local(over: Partial<LocalOpenOrder> = {}): LocalOpenOrder {
  return {
    id: "o1",
    symbol: "MKS.L",
    side: "sell",
    status: "submitted",
    quantity: 100,
    brokerOrderId: "B1",
    placedAt: ago(60 * 60_000),
    ...over,
  };
}

function working(over: Partial<BrokerWorkingOrder> = {}): BrokerWorkingOrder {
  return {
    brokerOrderId: "B1",
    symbol: "MKS:xlon",
    amount: 100,
    filledAmount: 0,
    buySell: "Sell",
    orderTime: ago(60 * 60_000),
    ...over,
  };
}

describe("classifyOrphanOrders", () => {
  it("cancels a sell that has rested too long at the broker", () => {
    const [f] = classifyOrphanOrders({ local: [local()], brokerWorking: [working()], nowMs: NOW });
    expect(f?.action).toBe("cancel_broker");
    expect(hasBlockingOrphans([f!])).toBe(true);
  });

  it("leaves a freshly placed working order alone", () => {
    const [f] = classifyOrphanOrders({
      local: [local({ placedAt: ago(2 * 60_000) })],
      brokerWorking: [working({ orderTime: ago(2 * 60_000) })],
      nowMs: NOW,
    });
    expect(f?.action).toBe("none");
  });

  it("sends an order the broker no longer lists to the reconciler", () => {
    const [f] = classifyOrphanOrders({ local: [local()], brokerWorking: [], nowMs: NOW });
    expect(f?.action).toBe("reconcile");
  });

  it("closes an order that never received a broker id", () => {
    const [f] = classifyOrphanOrders({
      local: [local({ brokerOrderId: null })],
      brokerWorking: [],
      nowMs: NOW,
    });
    expect(f?.action).toBe("close_local");
  });

  it("keeps a brand-new order without a broker id pending", () => {
    const [f] = classifyOrphanOrders({
      local: [local({ brokerOrderId: null, placedAt: ago(30_000) })],
      brokerWorking: [],
      nowMs: NOW,
    });
    expect(f?.action).toBe("none");
  });

  it("closes an order past the recovery window", () => {
    const [f] = classifyOrphanOrders({
      local: [local({ placedAt: ago(72 * 3600_000) })],
      brokerWorking: [],
      nowMs: NOW,
    });
    expect(f?.action).toBe("close_local");
  });

  it("never closes rows when the broker list could not be fetched", () => {
    const findings = classifyOrphanOrders({
      local: [local({ placedAt: ago(72 * 3600_000) })],
      brokerWorking: [],
      brokerListOk: false,
      nowMs: NOW,
    });
    expect(findings.every((f) => f.action === "none")).toBe(true);
  });

  it("cancels a stale broker order with no local row", () => {
    const findings = classifyOrphanOrders({
      local: [],
      brokerWorking: [working({ brokerOrderId: "GHOST" })],
      nowMs: NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.action).toBe("cancel_untracked");
    expect(findings[0]!.brokerOrderId).toBe("GHOST");
  });

  it("ignores fully filled broker orders", () => {
    const findings = classifyOrphanOrders({
      local: [],
      brokerWorking: [working({ brokerOrderId: "DONE", filledAmount: 100 })],
      nowMs: NOW,
    });
    expect(findings).toHaveLength(0);
  });
});
