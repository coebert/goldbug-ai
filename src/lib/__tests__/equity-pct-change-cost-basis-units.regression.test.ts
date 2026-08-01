// Regression: the "% since purchase" figure must be identical in meaning for
// GBX-quoted LSE rows (MKS, HSBA, TSCO — feed closes arrive in pence) and for
// rows whose feed is already in the base currency (VUKE, ISF-style GBP ETFs,
// US stocks). The historical bug divided the LSE cost basis a second time on
// the read path and printed +9900%; the mirror-image bug divides a GBP quote
// by 100 and prints -99%.
//
// Rule locked here:
//   pct = (normaliseFeedPrice(symbol, close) - holdingAvgCostBase(avg_cost)) / avg_cost
// with the divisor applied to the FEED only, never to the stored cost basis.

import { describe, expect, it } from "vitest";
import { buildHoldingSeries } from "@/lib/build-holding-series";
import {
  holdingAvgCostBase,
  normalizeLseDisplayPriceToBase,
} from "@/lib/market-price-units";

/** Reference implementation of the contract, used to cross-check the builder. */
function expectedPct(symbol: string, avgCostBase: number, feedClose: number) {
  const price = normalizeLseDisplayPriceToBase(symbol, feedClose);
  return (price - avgCostBase) / avgCostBase;
}

describe("equity % change is unit-correct for pence and GBP cost bases", () => {
  it("GBX-quoted LSE row: pence feed vs GBP cost basis", () => {
    // MKS bought at £4.0416, now 396p = £3.96 → -2.02%.
    const s = buildHoldingSeries(
      { symbol: "MKS:xlon", quantity: 879, avg_cost: 4.0416, opened_at: "2026-07-29" },
      [
        { date: "2026-07-29", close: 404.16 },
        { date: "2026-08-01", close: 396.0 },
      ],
    );
    expect(s.currentPrice).toBeCloseTo(3.96, 10);
    expect(s.pctChangeSincePurchase!).toBeCloseTo(
      expectedPct("MKS:xlon", 4.0416, 396),
      12,
    );
    expect(s.pctChangeSincePurchase!).toBeCloseTo(-0.020190, 5);
    expect(s.valueChangeSincePurchase!).toBeCloseTo((3.96 - 4.0416) * 879, 6);
  });

  it("GBP-quoted LSE ETF row: no divisor on either side", () => {
    // VUKE is on the GBP allowlist: feed 47.60 is already pounds.
    const s = buildHoldingSeries(
      { symbol: "VUKE.L", quantity: 100, avg_cost: 46.0, opened_at: "2026-07-29" },
      [{ date: "2026-08-01", close: 47.6 }],
    );
    expect(s.currentPrice).toBeCloseTo(47.6, 10);
    expect(s.pctChangeSincePurchase!).toBeCloseTo(expectedPct("VUKE.L", 46, 47.6), 12);
    expect(s.pctChangeSincePurchase!).toBeCloseTo(0.034783, 5);
  });

  it("non-LSE row is untouched by the pence rule", () => {
    const s = buildHoldingSeries(
      { symbol: "AAPL", quantity: 10, avg_cost: 210.5, opened_at: "2026-07-29" },
      [{ date: "2026-08-01", close: 195.0 }],
    );
    expect(s.pctChangeSincePurchase!).toBeCloseTo((195 - 210.5) / 210.5, 12);
  });

  it("identical economics in pence and GBP produce identical percentages", () => {
    const pence = buildHoldingSeries(
      { symbol: "TSCO.L", quantity: 1, avg_cost: 4.0, opened_at: "2026-07-29" },
      [{ date: "2026-08-01", close: 440.0 }], // 440p = £4.40
    );
    const pounds = buildHoldingSeries(
      { symbol: "VUKE.L", quantity: 1, avg_cost: 4.0, opened_at: "2026-07-29" },
      [{ date: "2026-08-01", close: 4.4 }],
    );
    expect(pence.pctChangeSincePurchase!).toBeCloseTo(0.1, 12);
    expect(pounds.pctChangeSincePurchase!).toBeCloseTo(
      pence.pctChangeSincePurchase!,
      12,
    );
  });

  it("never reproduces the +9900% / -99% unit-mixing signatures", () => {
    const rows: Array<[string, number, number]> = [
      ["MKS:xlon", 4.0416, 396],
      ["HSBA.L", 15.5742, 1560],
      ["TSCO.L", 4.02, 405],
      ["ULVR:xlon", 45.1, 4490],
      ["VUKE.L", 46.0, 47.6],
      ["AAPL", 210.5, 195],
    ];
    for (const [symbol, avg, close] of rows) {
      const s = buildHoldingSeries(
        { symbol, quantity: 1, avg_cost: avg, opened_at: "2026-07-29" },
        [{ date: "2026-08-01", close }],
      );
      expect(s.avg_cost).toBeCloseTo(holdingAvgCostBase(symbol, avg), 12);
      expect(Math.abs(s.pctChangeSincePurchase!)).toBeLessThan(0.5);
    }
  });

  it("anchors the series at the cost basis in base currency, not pence", () => {
    const s = buildHoldingSeries(
      { symbol: "HSBA.L", quantity: 50, avg_cost: 15.5742, opened_at: "2026-07-29" },
      [{ date: "2026-08-01", close: 1560 }],
    );
    expect(s.closes[0]).toBeCloseTo(15.5742, 10);
    expect(s.closes[1]).toBeCloseTo(15.6, 10);
  });
});
