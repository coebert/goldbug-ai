import { describe, expect, it } from "vitest";
import { chargeSymbolKey, matchChargesToFills, type IngestFill } from "@/lib/broker-cost-ingest";
import type { BrokerTradeCharge } from "@/lib/brokers/adapter";
import { computeFrictionKpi, type FrictionFill } from "@/lib/friction-kpi";

function fill(over: Partial<IngestFill> = {}): IngestFill {
  return {
    id: "f1",
    symbol: "AAPL:xnas",
    side: "buy",
    quantity: 10,
    fillPrice: 100,
    currency: "USD",
    filledAt: "2026-08-20T14:00:00.000Z",
    brokerFillId: null,
    brokerTradeId: null,
    feeSource: null,
    ...over,
  };
}

function charge(over: Partial<BrokerTradeCharge> = {}): BrokerTradeCharge {
  return {
    brokerTradeId: "T-1",
    symbol: "AAPL",
    side: "buy",
    quantity: 10,
    currency: "USD",
    commission: 5,
    exchangeFee: 1,
    tax: 0,
    other: 0,
    total: 6,
    tradedAt: "2026-08-20T14:00:00.000Z",
    ...over,
  } as BrokerTradeCharge;
}

describe("chargeSymbolKey", () => {
  it("reduces broker-native and exchange-suffixed tickers to one key", () => {
    expect(chargeSymbolKey("AAPL:xnas")).toBe("AAPL");
    expect(chargeSymbolKey("VOD.L")).toBe("VOD");
    expect(chargeSymbolKey("vod:xlon")).toBe("VOD");
  });
});

describe("matchChargesToFills", () => {
  it("prefers the broker trade id on a re-sync and stays idempotent", () => {
    const f = fill({ brokerTradeId: "T-1", feeSource: "broker" });
    const first = matchChargesToFills({ fills: [f], charges: [charge()] });
    const second = matchChargesToFills({ fills: [f], charges: [charge()] });
    expect(first.updates).toHaveLength(1);
    expect(first.updates[0]?.matchedBy).toBe("trade-id");
    // Re-running the same report must not produce a second, additive charge.
    expect(second.updates).toEqual(first.updates);
  });

  it("matches on our client reference when no trade id is known", () => {
    const f = fill({ id: "f9" });
    const res = matchChargesToFills({
      fills: [f],
      charges: [charge({ clientOrderId: "ext-42" })],
      clientOrderIdsByFill: { f9: "ext-42" },
    });
    expect(res.updates[0]?.matchedBy).toBe("order-id");
    expect(res.updates[0]?.fillId).toBe("f9");
  });

  it("falls back to symbol/side/qty/time when the report carries no ids", () => {
    const res = matchChargesToFills({
      fills: [fill()],
      charges: [charge({ brokerTradeId: "T-7", tradedAt: "2026-08-21T00:00:00.000Z" })],
    });
    expect(res.updates[0]?.matchedBy).toBe("attributes");
    expect(res.updates[0]?.brokerTradeId).toBe("T-7");
  });

  it("never applies one charge to two fills", () => {
    const a = fill({ id: "a" });
    const b = fill({ id: "b" });
    const res = matchChargesToFills({ fills: [a, b], charges: [charge()] });
    expect(res.updates).toHaveLength(1);
    expect(res.unmatchedFillIds).toHaveLength(1);
  });

  it("reports charges belonging to no fill we hold", () => {
    const res = matchChargesToFills({
      fills: [fill()],
      charges: [charge({ brokerTradeId: "T-x", symbol: "TSLA", quantity: 3 })],
    });
    expect(res.unmatchedTradeIds).toContain("T-x");
  });

  it("does not match the opposite side or a distant date", () => {
    const wrongSide = matchChargesToFills({ fills: [fill()], charges: [charge({ side: "sell" })] });
    expect(wrongSide.updates).toHaveLength(0);
    const stale = matchChargesToFills({
      fills: [fill()],
      charges: [charge({ tradedAt: "2026-07-01T00:00:00.000Z" })],
    });
    expect(stale.updates).toHaveLength(0);
  });
});

function kpiFill(over: Partial<FrictionFill> = {}): FrictionFill {
  return {
    symbol: "AAPL",
    side: "buy",
    notionalBase: 1000,
    feeReportedBase: 0,
    feeModelledBase: 4,
    commissionModelledBase: 2,
    spreadModelledBase: 1,
    taxModelledBase: 1,
    filledAt: "2026-08-20T14:00:00.000Z",
    ...over,
  };
}

describe("friction KPI with broker-booked charges", () => {
  it("uses the invoice split and books the un-invoiced excess as spread", () => {
    // Broker bills 6 (commission 5 + duty 1); the model says the all-in cost
    // is 9. The extra 3 is implicit half-spread the broker never invoices.
    const kpi = computeFrictionKpi({
      navBase: 100_000,
      fills: [
        kpiFill({
          feeSource: "broker",
          feeReportedBase: 6,
          feeModelledBase: 9,
          reportedComponents: { commissionBase: 5, spreadBase: 0, taxBase: 1 },
        }),
      ],
    });
    expect(kpi.components.commissionBase).toBeCloseTo(5, 6);
    expect(kpi.components.taxBase).toBeCloseTo(1, 6);
    expect(kpi.components.spreadBase).toBeCloseTo(3, 6);
    expect(kpi.frictionBase).toBeCloseTo(9, 6);
  });

  it("scales the invoice down when the broker charge exceeds the model", () => {
    const kpi = computeFrictionKpi({
      navBase: 100_000,
      fills: [
        kpiFill({
          feeSource: "broker",
          feeReportedBase: 10,
          feeModelledBase: 2,
          reportedComponents: { commissionBase: 8, spreadBase: 0, taxBase: 2 },
        }),
      ],
    });
    // Charged is the larger of the two: the invoice, kept whole.
    expect(kpi.frictionBase).toBeCloseTo(10, 6);
    expect(kpi.components.commissionBase).toBeCloseTo(8, 6);
    expect(kpi.components.taxBase).toBeCloseTo(2, 6);
  });

  it("reports what fraction of tickets is invoiced rather than modelled", () => {
    const kpi = computeFrictionKpi({
      navBase: 100_000,
      fills: [
        kpiFill({ feeSource: "broker", feeReportedBase: 5 }),
        kpiFill({ feeSource: "none" }),
        kpiFill({ feeSource: "broker", feeReportedBase: 5 }),
        kpiFill({ feeSource: "model" }),
      ],
    });
    expect(kpi.brokerBookedTickets).toBe(2);
    expect(kpi.brokerCoverage).toBeCloseTo(0.5, 6);
  });

  it("keeps the modelled split when no invoice is attached", () => {
    const kpi = computeFrictionKpi({ navBase: 100_000, fills: [kpiFill()] });
    expect(kpi.brokerCoverage).toBe(0);
    expect(kpi.components.commissionBase).toBeCloseTo(2, 6);
    expect(kpi.components.spreadBase).toBeCloseTo(1, 6);
  });
});
