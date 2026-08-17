import { describe, it, expect } from "vitest";
import { tickSizeForPrice, roundPriceToTick } from "@/lib/broker-tick-size";

describe("tickSizeForPrice", () => {
  it("reads the banded element that covers the price", () => {
    const scheme = {
      DefaultTickSize: 1,
      Elements: [
        { HighPrice: 100, TickSize: 0.1 },
        { HighPrice: 500, TickSize: 0.2 },
      ],
    };
    expect(tickSizeForPrice(50, scheme)).toBe(0.1);
    expect(tickSizeForPrice(404.75, scheme)).toBe(0.2);
    expect(tickSizeForPrice(900, scheme)).toBe(1);
  });

  it("falls back to the LSE pence ladder when no scheme is available", () => {
    expect(tickSizeForPrice(404.75, null, { penceQuoted: true })).toBe(0.2);
    expect(tickSizeForPrice(404.75, null)).toBeNull();
  });
});

describe("roundPriceToTick", () => {
  it("snaps a sell down and a buy up onto the tick grid", () => {
    // The exact MKS rejection: 404.75p with a 0.20p tick.
    expect(roundPriceToTick(404.75, 0.2, "sell")).toBeCloseTo(404.6, 6);
    expect(roundPriceToTick(404.75, 0.2, "buy")).toBeCloseTo(404.8, 6);
  });

  it("leaves prices already on the grid untouched", () => {
    expect(roundPriceToTick(404.6, 0.2, "sell")).toBeCloseTo(404.6, 6);
    expect(roundPriceToTick(404.6, 0.2, "buy")).toBeCloseTo(404.6, 6);
  });

  it("falls back to 2dp when the tick is unknown and is NaN-safe", () => {
    expect(roundPriceToTick(210.5551, null, "buy")).toBe(210.56);
    expect(roundPriceToTick(Number.NaN, 0.2, "sell")).toBe(0);
  });
});
