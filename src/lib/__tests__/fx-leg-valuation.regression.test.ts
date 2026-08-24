// Regression: a stranded broker FX spot leg must not be valued at notional.
//
// 24 Aug 2026: the live account carried `GBPUSD qty -1233.52` (the funding leg
// of a rejected SPY buy). Valued as quantity x price it removed ~GBP 1.68k from
// a GBP 9.9k NAV, which read as a −17% day and a 20% drawdown and hard-halted
// every buy for three days while the broker's own NAV was flat.

import { describe, it, expect } from "vitest";
import { holdingNativeValue, isFxLegHolding } from "../fx-leg-value";
import { computeValuation } from "../valuation/kernel";

describe("FX spot legs contribute P&L, not notional", () => {
  it("classifies fx asset_class rows", () => {
    expect(isFxLegHolding({ asset_class: "fx" })).toBe(true);
    expect(isFxLegHolding({ asset_class: "etf" })).toBe(false);
  });

  it("values an FX leg at unrealised P&L", () => {
    expect(
      holdingNativeValue({ assetClass: "fx", quantity: -1233.52, price: 1.36, avgCost: 1.3639 }),
    ).toBeCloseTo(-1233.52 * (1.36 - 1.3639), 6);
    // equities keep qty x price
    expect(holdingNativeValue({ assetClass: "stock", quantity: 10, price: 5, avgCost: 4 })).toBe(50);
  });

  it("keeps NAV intact when a short GBPUSD funding leg is open", () => {
    const res = computeValuation({
      holdings: [
        { symbol: "BP:xlon", quantity: 154, avg_cost: 5.5, asset_class: "stock", instrument_ccy: "GBP" },
        { symbol: "GBPUSD", quantity: -1233.52, avg_cost: 1.3639, asset_class: "fx", instrument_ccy: "USD" },
      ],
      price: (s: string) => (s.toUpperCase().startsWith("BP") ? 5.5 : 1.3639),
      wallet: { GBP: 6341.91 },
      baseCcy: "GBP",
      fx: () => 1,
    });
    // 154 x 5.50 + 6341.91, with the FX leg contributing ~0.
    expect(res.totalValue).toBeCloseTo(7188.91, 2);
  });
});
