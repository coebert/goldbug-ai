// Regression: on 2026-08-01 the live book rendered "MKS:xlon 879 @ GBP 0.04"
// with "+9900.34%" (HSBA +9901%, ULVR +9896%, TSCO +9900%). The market values
// were correct — only the cost basis was wrong, by exactly 100x.
//
// Cause: after the writers (live-holdings-sync, fills-trades-reconcile) were
// fixed to store LSE cost basis in GBP, the read paths kept applying the
// GBX→GBP divisor a second time. £4.04 → £0.0404 → a ~9900% "gain".
//
// Rule locked here: `holdings.avg_cost` is ALWAYS in the portfolio base
// currency; read paths use it verbatim. Feed prices (price_cache closes,
// broker quotes) still get normalised.

import { describe, expect, it } from "vitest";
import {
  holdingAvgCostBase,
  normalizeLseDisplayPriceToBase,
} from "@/lib/market-price-units";
import { buildHoldingSeries } from "@/lib/build-holding-series";
import { deriveStripAllocation } from "@/lib/derive-strip-allocation";

describe("LSE cost basis is never divided twice", () => {
  it("holdingAvgCostBase passes GBX-listed symbols through unchanged", () => {
    expect(holdingAvgCostBase("MKS:xlon", 4.0416)).toBeCloseTo(4.0416, 10);
    expect(holdingAvgCostBase("HSBA.L", "15.5742")).toBeCloseTo(15.5742, 10);
    expect(holdingAvgCostBase("AAPL", 210.5)).toBeCloseTo(210.5, 10);
  });

  it("still normalises feed prices, which do arrive in pence", () => {
    expect(normalizeLseDisplayPriceToBase("MKS:xlon", 396)).toBeCloseTo(3.96, 10);
  });

  it("returns 0 for unusable cost values rather than NaN", () => {
    expect(holdingAvgCostBase("MKS:xlon", null)).toBe(0);
    expect(holdingAvgCostBase("MKS:xlon", "not-a-number")).toBe(0);
  });

  it("the real MKS row reports a single-digit percent move, not +9900%", () => {
    const s = buildHoldingSeries(
      {
        symbol: "MKS:xlon",
        quantity: 879,
        avg_cost: 4.0416, // GBP, as persisted
        opened_at: "2026-07-29",
        asset_class: "stock",
      },
      [
        { date: "2026-07-29", close: 404.16 }, // feed pence
        { date: "2026-08-01", close: 396.0 },
      ],
    );
    expect(s.avg_cost).toBeCloseTo(4.0416, 6);
    expect(s.closes[0]).toBeCloseTo(4.0416, 6);
    expect(s.pctChangeSincePurchase!).toBeLessThan(0.5);
    expect(s.pctChangeSincePurchase!).toBeGreaterThan(-0.5);
  });

  it("strip allocation values the MKS line near its market value", () => {
    const a = deriveStripAllocation(
      [{ symbol: "MKS:xlon", quantity: 879, avg_cost: 4.0416, asset_class: "stock" }],
      1300.27,
      4782.06,
    );
    // 879 × £4.0416 ≈ £3552, not £35.52.
    expect(a.rawInvested).toBeGreaterThan(3000);
    expect(a.rawInvested).toBeLessThan(4000);
  });
});
