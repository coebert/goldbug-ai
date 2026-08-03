import { describe, expect, it } from "vitest";
import {
  buildReconciliationReport,
  type BrokerOrderRow,
  type PlannedAttempt,
} from "@/lib/trade-reconciliation";

const SUITABILITY_TEXT =
  "The order has been rejected because the instrument is not currently suitable for you or because a suitability test has not been taken.";

function plan(p: Partial<PlannedAttempt> = {}): PlannedAttempt {
  return {
    decisionId: "d1",
    runDate: "2026-08-03",
    symbol: "AAPL",
    side: "buy",
    quantity: 10,
    price: 100,
    value: 1000,
    reason: "momentum",
    engineRejection: null,
    ...p,
  };
}

function order(o: Partial<BrokerOrderRow> = {}): BrokerOrderRow {
  return {
    id: "o1",
    decisionId: "d1",
    symbol: "AAPL",
    side: "buy",
    quantity: 10,
    status: "filled",
    rejectReason: null,
    brokerOrderId: "SX1",
    createdAt: "2026-08-03T09:00:00Z",
    ...o,
  };
}

describe("buildReconciliationReport", () => {
  it("marks a fully filled attempt as filled", () => {
    const r = buildReconciliationReport({
      planned: [plan()],
      orders: [order()],
      fills: [{ orderId: "o1", quantity: 10, fillPrice: 101 }],
      activeBlocks: [],
    });
    expect(r.rows[0].outcome).toBe("filled");
    expect(r.rows[0].avgFillPrice).toBe(101);
    expect(r.summary.filled).toBe(1);
    expect(r.summary.unexecutedValue).toBe(0);
  });

  it("detects partial fills", () => {
    const r = buildReconciliationReport({
      planned: [plan()],
      orders: [order({ status: "partial" })],
      fills: [{ orderId: "o1", quantity: 4, fillPrice: 100 }],
      activeBlocks: [],
    });
    expect(r.rows[0].outcome).toBe("partial");
    expect(r.rows[0].filledQuantity).toBe(4);
  });

  it("classifies a Saxo suitability rejection and gives next steps", () => {
    const r = buildReconciliationReport({
      planned: [plan({ symbol: "SGLN.L", value: 500 })],
      orders: [
        order({ symbol: "SGLN:xlon", status: "rejected", rejectReason: SUITABILITY_TEXT }),
      ],
      fills: [],
      activeBlocks: [],
    });
    const row = r.rows[0];
    expect(row.outcome).toBe("rejected_suitability");
    expect(row.blockReason).toBe("suitability");
    expect(row.recommendedAction).toMatch(/appropriateness\/suitability test/i);
    expect(r.summary.suitabilityRejected).toBe(1);
    expect(r.summary.suitabilityBlockedValue).toBe(500);
    expect(r.suitability[0].symbolKey).toBe("SGLN");
  });

  it("separates ordinary broker rejections from suitability ones", () => {
    const r = buildReconciliationReport({
      planned: [plan()],
      orders: [order({ status: "rejected", rejectReason: "Insufficient funds" })],
      fills: [],
      activeBlocks: [],
    });
    expect(r.rows[0].outcome).toBe("rejected_broker");
    expect(r.rows[0].blockReason).toBeNull();
    expect(r.summary.otherBrokerRejected).toBe(1);
  });

  it("reports pre-trade suppression when the symbol is on the blocklist", () => {
    const r = buildReconciliationReport({
      planned: [plan({ symbol: "SGLN.L" })],
      orders: [],
      fills: [],
      activeBlocks: [{ symbolKey: "SGLN:xlon", reason: "suitability" }],
    });
    expect(r.rows[0].outcome).toBe("blocked_pre_trade");
    expect(r.suitability[0].stillBlocked).toBe(true);
    expect(r.summary.blockedPreTrade).toBe(1);
  });

  it("attributes engine guardrail vetoes separately from broker refusals", () => {
    const r = buildReconciliationReport({
      planned: [plan({ engineRejection: "cash floor breached" })],
      orders: [],
      fills: [],
      activeBlocks: [],
    });
    expect(r.rows[0].outcome).toBe("vetoed_by_engine");
    expect(r.rows[0].explanation).toMatch(/cash floor/);
  });

  it("flags planned trades with no broker order at all", () => {
    const r = buildReconciliationReport({
      planned: [plan()],
      orders: [],
      fills: [],
      activeBlocks: [],
    });
    expect(r.rows[0].outcome).toBe("not_routed");
    expect(r.summary.unexecutedValue).toBe(1000);
  });

  it("does not reuse one broker order for two planned attempts", () => {
    const r = buildReconciliationReport({
      planned: [plan(), plan({ decisionId: "d2" })],
      orders: [order()],
      fills: [{ orderId: "o1", quantity: 10, fillPrice: 100 }],
      activeBlocks: [],
    });
    expect(r.rows.map((x) => x.outcome).sort()).toEqual(["filled", "not_routed"]);
  });

  it("aggregates repeat suitability attempts per symbol", () => {
    const r = buildReconciliationReport({
      planned: [
        plan({ symbol: "SGLN.L", runDate: "2026-08-01", value: 300 }),
        plan({ decisionId: "d2", symbol: "SGLN.L", runDate: "2026-08-03", value: 200 }),
      ],
      orders: [
        order({ id: "o1", symbol: "SGLN.L", status: "rejected", rejectReason: SUITABILITY_TEXT }),
        order({
          id: "o2",
          decisionId: "d2",
          symbol: "SGLN.L",
          status: "rejected",
          rejectReason: SUITABILITY_TEXT,
        }),
      ],
      fills: [],
      activeBlocks: [],
    });
    expect(r.suitability).toHaveLength(1);
    expect(r.suitability[0].attempts).toBe(2);
    expect(r.suitability[0].blockedValue).toBe(500);
    expect(r.suitability[0].firstSeen).toBe("2026-08-01");
    expect(r.suitability[0].lastSeen).toBe("2026-08-03");
  });
});
