// Golden regression suite for the valuation kernel.
//
// Every historical wrong-number incident this app has had is pinned here as a
// case with its expected total. If a change to units, FX, or fallbacks breaks
// one of these, the test names say exactly which bug came back.

import { describe, expect, it } from "vitest";
import { computeValuation, resolveQuoteUnits, type ComputeValuationInput } from "../kernel";

const FX: Record<string, number> = {
  "USD>GBP": 0.79,
  "EUR>GBP": 0.85,
  "JPY>GBP": 0.0052,
  "AUD>GBP": 0.52,
  "CHF>GBP": 0.88,
};

function run(partial: Partial<ComputeValuationInput> & Pick<ComputeValuationInput, "holdings">) {
  return computeValuation({
    wallet: {},
    baseCcy: "GBP",
    price: () => null,
    fx: (from, to) => (from === to ? 1 : (FX[`${from}>${to}`] ?? null)),
    ...partial,
  });
}

describe("valuation kernel — golden cases", () => {
  it("LSE pence quote is not counted as pounds (the 100x tile)", () => {
    const res = run({
      holdings: [{ symbol: "MKS.L", quantity: 100, avg_cost: 3.5, instrument_ccy: "GBP" }],
      price: () => 350, // pence
    });
    // 100 shares at 350p = GBP 350, not GBP 35,000.
    expect(res.total).toBeCloseTo(350, 6);
  });

  it("already-normalised GBP prices are not divided a second time", () => {
    const res = run({
      holdings: [{ symbol: "MKS.L", quantity: 100, avg_cost: 3.5, instrument_ccy: "GBP" }],
      price: () => 3.5,
      observedQuoteCcy: () => "GBP",
    });
    expect(res.total).toBeCloseTo(350, 6);
  });

  it("USD holdings are FX-converted, never counted 1:1 as GBP", () => {
    const res = run({
      holdings: [{ symbol: "AAPL", quantity: 10, avg_cost: 150, instrument_ccy: "USD" }],
      price: () => 200,
    });
    expect(res.total).toBeCloseTo(10 * 200 * 0.79, 6);
  });

  it("flags a missing FX rate instead of silently using 1:1", () => {
    const res = computeValuation({
      holdings: [{ symbol: "PETR4.SA", quantity: 10, avg_cost: 30, instrument_ccy: "BRL" }],
      wallet: {},
      baseCcy: "GBP",
      price: () => 40,
      fx: () => null,
    });
    expect(res.warnings.map((w) => w.code)).toContain("fx_fallback_identity");
  });

  it("multi-currency wallet is converted per currency", () => {
    const res = run({
      holdings: [],
      wallet: { GBP: 1000, USD: 1000, EUR: 1000 },
    });
    expect(res.cashTotal).toBeCloseTo(1000 + 790 + 850, 6);
  });

  it("GBX wallet balance is treated as pence", () => {
    const res = run({ holdings: [], wallet: { GBX: 10_000 } });
    expect(res.cashTotal).toBeCloseTo(100, 6);
  });

  it("cash + holdings identity always holds", () => {
    const res = run({
      holdings: [
        { symbol: "AAPL", quantity: 10, avg_cost: 150, instrument_ccy: "USD" },
        { symbol: "MKS.L", quantity: 100, avg_cost: 3.5, instrument_ccy: "GBP" },
      ],
      wallet: { GBP: 500, USD: 200 },
      price: (s) => (s === "AAPL" ? 200 : 350),
    });
    expect(res.total).toBeCloseTo(res.cashTotal + res.holdingsTotal, 6);
  });

  it("cost-basis fallback is opt-in and marked in provenance", () => {
    const off = run({
      holdings: [{ symbol: "AAPL", quantity: 10, avg_cost: 150, instrument_ccy: "USD" }],
    });
    expect(off.holdingsTotal).toBe(0);
    expect(off.warnings.map((w) => w.code)).toContain("missing_price");

    const on = run({
      holdings: [{ symbol: "AAPL", quantity: 10, avg_cost: 150, instrument_ccy: "USD" }],
      allowCostBasisFallback: true,
    });
    expect(on.holdingsTotal).toBeCloseTo(10 * 150 * 0.79, 6);
    expect(on.lines[0]?.priceSource).toBe("cost_basis");
  });

  it("zero and negative quantities do not inflate the book", () => {
    const res = run({
      holdings: [
        { symbol: "AAPL", quantity: 0, avg_cost: 150, instrument_ccy: "USD" },
        { symbol: "TSLA", quantity: -5, avg_cost: 200, instrument_ccy: "USD" },
      ],
      price: () => 100,
    });
    expect(res.holdingsTotal).toBeCloseTo(-5 * 100 * 0.79, 6);
  });

  it("non-finite prices are rejected rather than producing NaN totals", () => {
    const res = run({
      holdings: [{ symbol: "AAPL", quantity: 10, avg_cost: 150, instrument_ccy: "USD" }],
      price: () => Number.NaN,
    });
    expect(Number.isFinite(res.total)).toBe(true);
  });
});

describe("resolveQuoteUnits", () => {
  it("divides LSE pence by 100 and leaves US quotes alone", () => {
    expect(resolveQuoteUnits("MKS.L", "GBP", "GBP").divisor).toBe(100);
    expect(resolveQuoteUnits("AAPL", "USD", "GBP").divisor).toBe(1);
  });

  it("honours an explicitly observed major-unit currency", () => {
    expect(resolveQuoteUnits("MKS.L", "GBP", "GBP", "GBP").divisor).toBe(1);
  });
});
