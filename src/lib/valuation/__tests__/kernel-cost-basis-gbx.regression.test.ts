// Regression: the kernel's cost-basis fallback used to divide `avg_cost` by
// the GBX unit divisor a second time. Because every writer already stores
// `holdings.avg_cost` normalised to base currency, that turned a GBP 4.04 MKS
// position into GBP 0.04 whenever no live price was available.

import { describe, expect, it } from "vitest";
import { computeValuation } from "../kernel";

function run(holdings: Parameters<typeof computeValuation>[0]["holdings"]) {
  return computeValuation({
    holdings,
    wallet: {},
    baseCcy: "GBP",
    price: () => null, // force the cost-basis fallback
    fx: (from, to) => (from === to ? 1 : null),
    allowCostBasisFallback: true,
  });
}

describe("kernel cost-basis fallback — GBX-quoted holdings", () => {
  it("values a pence-quoted LSE holding at its stored base-currency cost", () => {
    const res = run([
      { symbol: "MKS.L", quantity: 100, avg_cost: 4.04, instrument_ccy: "GBP" },
    ]);
    expect(res.provenance.lines[0]?.priceSource).toBe("cost_basis");
    // 100 x GBP 4.04 = GBP 404 — not GBP 4.04 (the 100x deflation bug).
    expect(res.holdingsValue).toBeCloseTo(404, 6);
  });

  it("leaves non-GBX holdings unchanged", () => {
    const res = run([
      { symbol: "AAPL", quantity: 10, avg_cost: 150, instrument_ccy: "GBP" },
    ]);
    expect(res.holdingsValue).toBeCloseTo(1_500, 6);
  });
});
