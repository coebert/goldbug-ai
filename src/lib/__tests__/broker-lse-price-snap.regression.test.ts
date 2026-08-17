import { describe, expect, it } from "vitest";
import { nativeQuotePrice } from "@/lib/market-price-units";
import { roundPriceToTick, tickSizeForPrice } from "@/lib/broker-tick-size";

// Locks the exact broker-bound price path that Saxo accepted on 2026-08-17
// (MKS order 5434537270 routed at 404.7 and went "working"). Both LSE names
// were previously rejected for "Price exceeds aggressive tolerance" (GBP
// units) and then "not in tick size increments" (404.75 off the grid).

// Saxo /ref/v1/instruments/details for LSE_SETS stocks in this price band.
const LSE_SETS_SCHEME = {
  DefaultTickSize: 1,
  Elements: [
    { HighPrice: 499.95, TickSize: 0.1 },
    { HighPrice: 999.9, TickSize: 0.2 },
    { HighPrice: 4999.5, TickSize: 0.5 },
  ],
};

function brokerPrice(
  symbol: string,
  basePrice: number,
  side: "buy" | "sell",
  brokerCcy = "GBX",
) {
  const native = nativeQuotePrice(symbol, basePrice, brokerCcy);
  const penceQuoted = native !== basePrice || brokerCcy.toUpperCase() === "GBX";
  const tick = tickSizeForPrice(native, LSE_SETS_SCHEME, { penceQuoted });
  return roundPriceToTick(native, tick, side);
}

describe("LSE broker price snap (MKS + TSCO)", () => {
  it("routes the rejected MKS sell in pence, on the tick grid", () => {
    // 4.047531 GBP was the engine limit that Saxo rejected twice.
    expect(brokerPrice("MKS:xlon", 4.047531, "sell")).toBeCloseTo(404.7, 6);
    expect(brokerPrice("MKS.L", 4.047531, "sell")).toBeCloseTo(404.7, 6);
  });

  it("routes the rejected TSCO sell in pence, on the tick grid", () => {
    expect(brokerPrice("TSCO.L", 4.564059, "sell")).toBeCloseTo(456.4, 6);
    expect(brokerPrice("TSCO:xlon", 4.564059, "sell")).toBeCloseTo(456.4, 6);
  });

  it("snaps buys up and sells down so the order stays marketable", () => {
    expect(brokerPrice("MKS:xlon", 4.047531, "buy")).toBeCloseTo(404.8, 6);
    expect(brokerPrice("TSCO.L", 4.564059, "buy")).toBeCloseTo(456.5, 6);
  });

  it("snaps protective stop prices the same way", () => {
    // ATR stop ~8% below the MKS mark, sell side → rounds down onto the grid.
    expect(brokerPrice("MKS:xlon", 3.7237, "sell")).toBeCloseTo(372.3, 6);
    expect(brokerPrice("TSCO.L", 4.19893, "sell")).toBeCloseTo(419.8, 6);
  });

  it("leaves GBP-quoted LSE ETFs in pounds and only rounds to their tick", () => {
    expect(brokerPrice("VUSA.L", 91.237, "sell", "GBP")).toBeCloseTo(91.23, 6);
  });

  it("every snapped price is an exact multiple of its tick", () => {
    for (const base of [4.047531, 4.564059, 3.7237, 9.9999]) {
      for (const side of ["buy", "sell"] as const) {
        const p = brokerPrice("MKS:xlon", base, side);
        const tick = tickSizeForPrice(p, LSE_SETS_SCHEME, { penceQuoted: true })!;
        expect(Math.abs(Math.round(p / tick) - p / tick)).toBeLessThan(1e-6);
      }
    }
  });
});
