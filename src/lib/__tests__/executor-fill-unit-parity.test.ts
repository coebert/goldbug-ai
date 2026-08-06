// The fill-unit bug: the live executor booked Saxo's raw `avgFillPrice`
// straight into `live_fills`, while the order-reconcile path ran the same
// number through `resolveFillRecord`. For LSE common stocks Saxo quotes in
// GBX, so the same instrument landed in the ledger in two different units
// (HSBA at 1556.20 alongside 15.52) and every cost-basis / realised-PnL
// figure built on top of it was wrong.
//
// Both write paths must now agree, symbol for symbol.

import { describe, it, expect } from "vitest";
import { resolveFillRecord } from "../fill-record";

function book(symbol: string, brokerPrice: number) {
  return resolveFillRecord({
    symbol,
    candidates: [{ source: "broker_avg_fill_price", value: brokerPrice, raw: true }],
    portfolioCurrency: "GBP",
  });
}

describe("executor fill unit parity", () => {
  it("folds GBX-quoted LSE common stocks into pounds", () => {
    expect(book("HSBA.L", 1556.2)?.fillPrice).toBeCloseTo(15.562, 6);
    expect(book("MKS.L", 405.278662)?.fillPrice).toBeCloseTo(4.05278662, 8);
    expect(book("TSCO.L", 487.163485)?.fillPrice).toBeCloseTo(4.87163485, 8);
  });

  it("leaves pound-quoted LSE ETFs untouched", () => {
    expect(book("VUKE.L", 47.255)?.fillPrice).toBeCloseTo(47.255, 6);
    expect(book("VMID.L", 36.44)?.fillPrice).toBeCloseTo(36.44, 6);
  });

  it("leaves non-LSE listings untouched and books their own currency", () => {
    const aapl = book("AAPL", 342.87);
    expect(aapl?.fillPrice).toBeCloseTo(342.87, 6);
    expect(aapl?.currency).toBe("USD");
  });

  it("books LSE fills in GBP, never GBX", () => {
    expect(book("HSBA.L", 1556.2)?.currency).toBe("GBP");
    expect(
      resolveFillRecord({
        symbol: "HSBA.L",
        candidates: [{ source: "broker_avg_fill_price", value: 1556.2, raw: true }],
        orderCcy: "GBX",
        portfolioCurrency: "GBP",
      })?.currency,
    ).toBe("GBP");
  });

  it("refuses to book a zero or missing broker price", () => {
    expect(book("HSBA.L", 0)).toBeNull();
    expect(
      resolveFillRecord({
        symbol: "HSBA.L",
        candidates: [{ source: "broker_avg_fill_price", value: null, raw: true }],
        portfolioCurrency: "GBP",
      }),
    ).toBeNull();
  });
});
