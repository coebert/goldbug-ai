// Regression: Saxo's LSE quotes are pence (GBX). The holdings-sync fallback
// (used whenever Saxo omits the account TotalValue) summed them raw, which
// valued a ~GBP 10.2k real-money account at ~GBP 817k on the dashboard.

import { describe, expect, it } from "vitest";
import { valueBrokerPositions } from "@/lib/broker-positions-value";

describe("valueBrokerPositions", () => {
  it("folds LSE pence quotes into GBP", () => {
    const value = valueBrokerPositions([
      { symbol: "MKS:xlon", quantity: 879, marketPrice: 361.6, assetClass: "stock" },
      { symbol: "HSBA:xlon", quantity: 175, marketPrice: 1560, assetClass: "stock" },
    ]);
    // 879 * 3.616 + 175 * 15.60
    expect(value).toBeCloseTo(879 * 3.616 + 175 * 15.6, 4);
    expect(value).toBeLessThan(10_000);
  });

  it("leaves non-LSE quotes untouched", () => {
    expect(
      valueBrokerPositions([
        { symbol: "AAPL:xnas", quantity: 2, marketPrice: 300, assetClass: "stock" },
      ]),
    ).toBeCloseTo(600, 6);
  });

  it("falls back to avgPrice and ignores unusable rows", () => {
    expect(
      valueBrokerPositions([
        { symbol: "TSCO:xlon", quantity: 100, marketPrice: 0, avgPrice: 489.4 },
        { symbol: "BAD:xlon", quantity: Number.NaN, marketPrice: 100 },
      ]),
    ).toBeCloseTo(489.4, 4);
  });

  it("keeps a whole real-money account within a sane order of magnitude", () => {
    const total = valueBrokerPositions([
      { symbol: "MKS:xlon", quantity: 879, marketPrice: 361.6 },
      { symbol: "HSBA:xlon", quantity: 175, marketPrice: 1560 },
      { symbol: "ULVR:xlon", quantity: 22, marketPrice: 4950 },
      { symbol: "TSCO:xlon", quantity: 160, marketPrice: 489 },
      { symbol: "AAPL:xnas", quantity: 2, marketPrice: 300 },
    ]);
    expect(total).toBeGreaterThan(1_000);
    expect(total).toBeLessThan(20_000);
  });
});
