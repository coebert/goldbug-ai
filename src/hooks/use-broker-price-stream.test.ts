import { describe, expect, it } from "vitest";
import { mergePriceRow, rowPrice } from "./use-broker-price-stream";

describe("mergePriceRow", () => {
  it("keeps the previous bid when a delta carries only the ask", () => {
    const prev = { Uic: 1, Quote: { Bid: 10, Ask: 10.2 } };
    const merged = mergePriceRow(prev, { Uic: 1, Quote: { Ask: 10.4 } });
    expect(merged.Quote).toEqual({ Bid: 10, Ask: 10.4 });
    expect(rowPrice(merged).raw).toBeCloseTo(10.2);
  });

  it("falls back to last traded, then last close", () => {
    expect(rowPrice({ PriceInfoDetails: { LastTraded: 5 } }).raw).toBe(5);
    expect(rowPrice({ PriceInfoDetails: { LastClose: 4 } }).raw).toBe(4);
    expect(rowPrice({}).raw).toBe(0);
  });

  it("merges nested detail blocks rather than replacing them", () => {
    const merged = mergePriceRow(
      { PriceInfoDetails: { LastTraded: 9, LastClose: 8 }, DisplayAndFormat: { Currency: "GBP" } },
      { PriceInfoDetails: { LastTraded: 9.5 } },
    );
    expect(merged.PriceInfoDetails).toEqual({ LastTraded: 9.5, LastClose: 8 });
    expect(merged.DisplayAndFormat?.Currency).toBe("GBP");
  });
});
