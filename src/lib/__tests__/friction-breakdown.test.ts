import { describe, expect, it } from "vitest";
import { frictionBreakdown, venueOf, type FrictionFill } from "../friction-kpi";

function fill(over: Partial<FrictionFill> = {}): FrictionFill {
  return {
    symbol: "AAPL:XNAS",
    side: "buy",
    notionalBase: 1000,
    feeReportedBase: 0,
    feeModelledBase: 5,
    commissionModelledBase: 3,
    spreadModelledBase: 2,
    taxModelledBase: 0,
    feeSource: "none",
    filledAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

describe("venueOf", () => {
  it("reads broker-native MICs and Yahoo suffixes", () => {
    expect(venueOf("AAPL:xnas")).toBe("XNAS");
    expect(venueOf("ISF.L")).toBe("XLON");
    expect(venueOf("SAP.DE")).toBe("XETR");
    expect(venueOf("BTC-USD")).toBe("CRYPTO");
    expect(venueOf("MSFT")).toBe("US");
    expect(venueOf("")).toBe("UNKNOWN");
  });
});

describe("frictionBreakdown", () => {
  const fills = [
    fill({ symbol: "ISF.L", feeModelledBase: 10, commissionModelledBase: 4, spreadModelledBase: 3, taxModelledBase: 3 }),
    fill({ symbol: "MKS.L", feeModelledBase: 6, commissionModelledBase: 2, spreadModelledBase: 2, taxModelledBase: 2 }),
    fill({ symbol: "AAPL:XNAS", feeReportedBase: 8, feeSource: "broker" }),
  ];

  it("groups by venue and sums to the same charged total as the tape", () => {
    const b = frictionBreakdown({ fills, by: "venue" });
    const keys = b.rows.map((r) => r.key).sort();
    expect(keys).toEqual(["XLON", "XNAS"]);
    const sum = b.rows.reduce((a, r) => a + r.chargedBase, 0);
    expect(sum).toBeCloseTo(b.totals.chargedBase, 10);
    // 10 + 6 modelled on LSE, max(8, 5) on Nasdaq.
    expect(b.totals.chargedBase).toBeCloseTo(24, 10);
  });

  it("keeps stamp duty on the UK venue only", () => {
    const b = frictionBreakdown({ fills, by: "venue" });
    const lse = b.rows.find((r) => r.key === "XLON")!;
    const us = b.rows.find((r) => r.key === "XNAS")!;
    expect(lse.components.taxBase).toBeCloseTo(5, 10);
    expect(us.components.taxBase).toBeCloseTo(0, 10);
  });

  it("computes realised ratio and coverage from invoiced tickets only", () => {
    const b = frictionBreakdown({ fills, by: "venue" });
    const lse = b.rows.find((r) => r.key === "XLON")!;
    const us = b.rows.find((r) => r.key === "XNAS")!;
    expect(lse.realisedRatio).toBeNull();
    expect(lse.brokerCoverage).toBe(0);
    expect(us.realisedRatio).toBeCloseTo(8 / 5, 10);
    expect(us.brokerCoverage).toBe(1);
    expect(b.totals.realisedRatio).toBeCloseTo(8 / 5, 10);
  });

  it("groups by asset and reports bps of that asset's turnover", () => {
    const b = frictionBreakdown({ fills, by: "asset" });
    expect(b.rows.map((r) => r.key)).toContain("ISF.L");
    const isf = b.rows.find((r) => r.key === "ISF.L")!;
    expect(isf.chargedBpsOfTurnover).toBeCloseTo(100, 6);
  });

  it("folds the tail into an Other row without losing money", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      fill({ symbol: `S${i}`, feeModelledBase: 10 - i }),
    );
    const b = frictionBreakdown({ fills: many, by: "asset", limit: 3 });
    expect(b.rows).toHaveLength(3);
    expect(b.rows[2]!.key).toBe("Other");
    const sum = b.rows.reduce((a, r) => a + r.chargedBase, 0);
    expect(sum).toBeCloseTo(b.totals.chargedBase, 10);
  });
});
