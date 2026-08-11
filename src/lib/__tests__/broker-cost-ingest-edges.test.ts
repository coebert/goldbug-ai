import { describe, expect, it, vi } from "vitest";
import {
  convertChargeLegs,
  matchChargesToFills,
  normaliseChargeCurrency,
  type ChargeUpdate,
  type IngestFill,
} from "@/lib/broker-cost-ingest";
import type { BrokerTradeCharge } from "@/lib/brokers/adapter";

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

const update = (over: Partial<ChargeUpdate> = {}): ChargeUpdate => ({
  fillId: "f1",
  brokerTradeId: "T-1",
  currency: "USD",
  commission: 5,
  exchangeFee: 1,
  tax: 0,
  other: 0,
  total: 6,
  matchedBy: "trade-id",
  ...over,
});

/** Deterministic stand-in for the FX layer. */
const rates: Record<string, number> = { USDGBP: 0.8, GBPUSD: 1.25, EURGBP: 0.85 };
const convert = async (amount: number, from: string, to: string) => {
  const r = rates[`${from}${to}`];
  if (r === undefined) throw new Error(`no rate ${from}->${to}`);
  return amount * r;
};

describe("ambiguous trade ids", () => {
  it("keeps two same-day identical tickets on their own charges", () => {
    // Same symbol, side and size twice in one session: only the timestamps
    // separate them, and a swap would misattribute cost between them.
    const fills = [
      fill({ id: "early", filledAt: "2026-08-20T08:05:00.000Z" }),
      fill({ id: "late", filledAt: "2026-08-20T15:40:00.000Z" }),
    ];
    const charges = [
      charge({ brokerTradeId: "T-late", tradedAt: "2026-08-20T15:41:00.000Z", total: 9 }),
      charge({ brokerTradeId: "T-early", tradedAt: "2026-08-20T08:06:00.000Z", total: 4 }),
    ];
    const res = matchChargesToFills({ fills, charges });
    const byFill = Object.fromEntries(res.updates.map((u) => [u.fillId, u.brokerTradeId]));
    expect(byFill).toEqual({ early: "T-early", late: "T-late" });
    expect(res.unmatchedFillIds).toEqual([]);
  });

  it("does not let a stale trade id on one fill steal another fill's charge", () => {
    // Broker restated T-1 onto a different execution; the fill that already
    // claims T-1 wins it, and the other falls through to attribute matching.
    const fills = [
      fill({ id: "claimed", brokerTradeId: "T-1" }),
      fill({ id: "fresh", filledAt: "2026-08-20T14:02:00.000Z" }),
    ];
    const charges = [charge({ brokerTradeId: "T-1" }), charge({ brokerTradeId: "T-2", total: 7 })];
    const res = matchChargesToFills({ fills, charges });
    expect(res.updates.find((u) => u.fillId === "claimed")?.brokerTradeId).toBe("T-1");
    expect(res.updates.find((u) => u.fillId === "fresh")?.brokerTradeId).toBe("T-2");
  });

  it("prefers the order id over an equally plausible attribute match", () => {
    const fills = [
      fill({ id: "a", brokerFillId: "O-9" }),
      fill({ id: "b", filledAt: "2026-08-20T14:00:30.000Z" }),
    ];
    const charges = [
      charge({ brokerTradeId: "T-attr", total: 3 }),
      charge({ brokerTradeId: "T-order", brokerOrderId: "O-9", total: 11 } as Partial<BrokerTradeCharge>),
    ];
    const res = matchChargesToFills({ fills, charges });
    expect(res.updates.find((u) => u.fillId === "a")?.brokerTradeId).toBe("T-order");
    expect(res.updates.find((u) => u.fillId === "a")?.matchedBy).toBe("order-id");
  });

  it("leaves a duplicate trade id in the report applied exactly once", () => {
    const fills = [fill({ id: "a" }), fill({ id: "b", filledAt: "2026-08-20T14:01:00.000Z" })];
    const charges = [charge({ brokerTradeId: "T-dup" }), charge({ brokerTradeId: "T-dup" })];
    const res = matchChargesToFills({ fills, charges });
    expect(res.updates).toHaveLength(1);
    expect(res.unmatchedFillIds).toHaveLength(1);
  });

  it("refuses a partial-fill quantity outside tolerance rather than guessing", () => {
    const res = matchChargesToFills({
      fills: [fill({ quantity: 10 })],
      charges: [charge({ quantity: 6 })],
    });
    expect(res.updates).toEqual([]);
    expect(res.unmatchedTradeIds).toEqual(["T-1"]);
  });

  it("accepts a rounding-level quantity difference on the same ticket", () => {
    const res = matchChargesToFills({
      fills: [fill({ quantity: 1000 })],
      charges: [charge({ quantity: 1000.4 })],
    });
    expect(res.updates).toHaveLength(1);
    expect(res.updates[0]?.matchedBy).toBe("attributes");
  });

  it("ignores a blank client reference instead of matching everything to it", () => {
    const res = matchChargesToFills({
      fills: [fill({ id: "a", symbol: "TSLA", filledAt: "2026-07-01T10:00:00.000Z" })],
      charges: [charge({ brokerTradeId: "T-x", clientOrderId: "" } as Partial<BrokerTradeCharge>)],
      clientOrderIdsByFill: { a: "" },
    });
    expect(res.updates).toEqual([]);
  });

  it("is stable when re-run over its own output", () => {
    const fills = [fill({ id: "a" }), fill({ id: "b", filledAt: "2026-08-20T14:05:00.000Z" })];
    const charges = [charge({ brokerTradeId: "T-1" }), charge({ brokerTradeId: "T-2", total: 8 })];
    const first = matchChargesToFills({ fills, charges });
    const synced = fills.map((f) => ({
      ...f,
      brokerTradeId: first.updates.find((u) => u.fillId === f.id)?.brokerTradeId ?? null,
    }));
    const second = matchChargesToFills({ fills: synced, charges });
    expect(second.updates.map((u) => [u.fillId, u.brokerTradeId, u.matchedBy])).toEqual(
      first.updates.map((u) => [u.fillId, u.brokerTradeId, "trade-id"]),
    );
  });
});

describe("normaliseChargeCurrency", () => {
  it("treats pence quotes as a scaled pound, not a separate currency", () => {
    expect(normaliseChargeCurrency("GBX")).toEqual({ code: "GBP", scale: 0.01 });
    expect(normaliseChargeCurrency(" gbp ")).toEqual({ code: "GBP", scale: 1 });
    expect(normaliseChargeCurrency("")).toEqual({ code: "GBP", scale: 1 });
  });
});

describe("convertChargeLegs", () => {
  it("converts every leg at the same rate and keeps legs summing to total", async () => {
    const legs = await convertChargeLegs(update({ commission: 5, exchangeFee: 1, total: 6 }), "GBP", convert);
    expect(legs.commission).toBeCloseTo(4, 10);
    expect(legs.exchangeFee).toBeCloseTo(0.8, 10);
    expect(legs.total).toBeCloseTo(legs.commission + legs.exchangeFee + legs.tax + legs.other, 12);
  });

  it("does not call FX when the charge is already in the fill's currency", async () => {
    const spy = vi.fn(convert);
    const legs = await convertChargeLegs(update({ currency: "usd" }), "USD", spy);
    expect(spy).not.toHaveBeenCalled();
    expect(legs.total).toBeCloseTo(6, 10);
  });

  it("divides a pence-denominated charge by 100", async () => {
    const legs = await convertChargeLegs(
      update({ currency: "GBX", commission: 250, exchangeFee: 0, tax: 500, other: 0, total: 750 }),
      "GBP",
      convert,
    );
    expect(legs.commission).toBeCloseTo(2.5, 10);
    expect(legs.tax).toBeCloseTo(5, 10);
    expect(legs.total).toBeCloseTo(7.5, 10);
  });

  it("scales up when the fill itself is booked in pence", async () => {
    const legs = await convertChargeLegs(update({ currency: "GBP", commission: 3, exchangeFee: 0, total: 3 }), "GBX", convert);
    expect(legs.commission).toBeCloseTo(300, 10);
    expect(legs.total).toBeCloseTo(300, 10);
  });

  it("books a broker total above its own itemisation as unattributed cost", async () => {
    const legs = await convertChargeLegs(
      update({ currency: "GBP", commission: 2, exchangeFee: 0, tax: 0, other: 0, total: 5 }),
      "GBP",
      convert,
    );
    expect(legs.other).toBeCloseTo(3, 10);
    expect(legs.total).toBeCloseTo(5, 10);
  });

  it("keeps the itemisation when it exceeds a understated total", async () => {
    const legs = await convertChargeLegs(
      update({ currency: "GBP", commission: 4, exchangeFee: 1, tax: 0, other: 0, total: 2 }),
      "GBP",
      convert,
    );
    expect(legs.total).toBeCloseTo(5, 10);
  });

  it("falls back to the unconverted amount rather than zero when FX is down", async () => {
    const legs = await convertChargeLegs(update({ currency: "JPY", commission: 900, exchangeFee: 0, total: 900 }), "GBP", async () => {
      throw new Error("fx outage");
    }).catch(() => null);
    // The pure helper propagates; the server's convertLeg is the resilient one.
    expect(legs).toBeNull();
    const resilient = await convertChargeLegs(
      update({ currency: "JPY", commission: 900, exchangeFee: 0, total: 900 }),
      "GBP",
      async (amount) => amount,
    );
    expect(resilient.total).toBeCloseTo(900, 10);
  });

  it("sanitises negative, NaN and infinite legs to zero", async () => {
    const legs = await convertChargeLegs(
      update({ currency: "GBP", commission: -5, exchangeFee: Number.NaN, tax: Number.POSITIVE_INFINITY, other: 0, total: 0 }),
      "GBP",
      convert,
    );
    expect(legs).toMatchObject({ commission: 0, exchangeFee: 0, tax: 0, other: 0, total: 0 });
  });

  it("never returns NaN for an unknown currency pair the converter cannot price", async () => {
    const legs = await convertChargeLegs(
      update({ currency: "EUR", commission: 10, exchangeFee: 0, total: 10 }),
      "GBP",
      async (amount, from, to) => (rates[`${from}${to}`] ?? Number.NaN) * amount,
    );
    expect(legs.commission).toBeCloseTo(8.5, 10);
    expect(Number.isFinite(legs.total)).toBe(true);
  });
});
