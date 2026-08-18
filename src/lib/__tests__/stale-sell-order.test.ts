import { describe, expect, it } from "vitest";
import { findStaleWorkingSell } from "@/lib/stale-sell-order";

const nowMs = Date.parse("2026-08-18T11:15:00Z");

describe("findStaleWorkingSell", () => {
  it("matches broker and engine symbol variants for an aged sell", () => {
    const stale = findStaleWorkingSell({
      symbol: "MKS.L",
      nowMs,
      working: [{
        brokerOrderId: "5434715463",
        symbol: "MKS:xlon",
        buySell: "Sell",
        amount: 775,
        filledAmount: 0,
        orderTime: "2026-08-17T16:09:25Z",
      }],
    });
    expect(stale?.brokerOrderId).toBe("5434715463");
  });

  it("does not replace a fresh sell", () => {
    expect(findStaleWorkingSell({
      symbol: "MKS:xlon",
      nowMs,
      working: [{
        brokerOrderId: "fresh",
        symbol: "MKS.L",
        buySell: "Sell",
        amount: 775,
        filledAmount: 0,
        orderTime: "2026-08-18T11:12:00Z",
      }],
    })).toBeNull();
  });

  it("ignores buys, fully filled orders, and different instruments", () => {
    const common = { amount: 775, filledAmount: 0, orderTime: "2026-08-17T16:09:25Z" };
    expect(findStaleWorkingSell({
      symbol: "MKS.L",
      nowMs,
      working: [
        { ...common, brokerOrderId: "buy", symbol: "MKS:xlon", buySell: "Buy" },
        { ...common, brokerOrderId: "filled", symbol: "MKS:xlon", buySell: "Sell", filledAmount: 775 },
        { ...common, brokerOrderId: "other", symbol: "TSCO:xlon", buySell: "Sell" },
      ],
    })).toBeNull();
  });
});