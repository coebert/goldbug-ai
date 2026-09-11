import { describe, expect, it } from "vitest";
import { buildGlobalCoverage, type CoverageSuggestion } from "../global-coverage";

const suggestion = (id: string, symbol: string, market = "US", at = "2026-09-01T10:00:00Z"): CoverageSuggestion => ({ id, symbol, name: symbol, market, marketLabel: market, suggestedAt: at, quantity: 10, conviction: 0.8, expectedEdgeBps: 200, expectedProfitBase: 20, suggestedPrice: 100, costBase: 3, fxToBase: 1, recommended: true, blockedReason: null });

describe("global coverage", () => {
  it("calculates full, partial, missed and pending signals without reusing fills", () => {
    const result = buildGlobalCoverage({
      suggestions: [suggestion("a", "AAPL"), suggestion("b", "SAP.DE", "EU"), suggestion("c", "7203.T", "JP"), suggestion("d", "BHP.AX", "ASX", "2026-09-10T10:00:00Z")],
      orders: [{ id: "oa", symbol: "AAPL", quantity: 10, status: "filled", reason: null, createdAt: "2026-09-01T11:00:00Z" }, { id: "ob", symbol: "SAP.DE", quantity: 10, status: "cancelled", reason: "limit expired", createdAt: "2026-09-01T11:00:00Z" }],
      fills: [{ orderId: "oa", symbol: "AAPL", quantity: 10, filledAt: "2026-09-01T11:05:00Z" }, { orderId: "ob", symbol: "SAP.DE", quantity: 4, filledAt: "2026-09-01T11:05:00Z" }],
      pricesNow: { AAPL: 110, "SAP.DE": 105, "7203.T": 110, "BHP.AX": 101 }, now: new Date("2026-09-11T12:00:00Z"),
    });
    expect(result.rows.map((row) => row.status)).toEqual(["filled", "partial", "missed", "pending"]);
    expect(result.groups.find((group) => group.market === "EU")?.fillRate).toBeCloseTo(0.4);
    expect(result.rows.find((row) => row.symbol === "7203.T")?.missReason).toBe("no_order");
  });

  it("keeps one fill from satisfying repeated suggestions", () => {
    const result = buildGlobalCoverage({ suggestions: [suggestion("a", "AAPL"), suggestion("b", "AAPL", "US", "2026-09-02T10:00:00Z")], orders: [], fills: [{ orderId: "o", symbol: "AAPL", quantity: 10, filledAt: "2026-09-02T11:00:00Z" }], pricesNow: { AAPL: 105 }, now: new Date("2026-09-10T00:00:00Z") });
    expect(result.rows.filter((row) => row.status === "filled")).toHaveLength(1);
    expect(result.rows.filter((row) => row.status === "missed")).toHaveLength(1);
  });
});