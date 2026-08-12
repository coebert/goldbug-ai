import { describe, it, expect } from "vitest";
import {
  assessNetEdge,
  expectedMovePct,
  DEFAULT_EDGE_SAFETY_MULTIPLE,
  MIN_EXPECTED_MOVE_PCT,
  MAX_EXPECTED_MOVE_PCT,
} from "../net-edge-gate";

describe("expectedMovePct", () => {
  it("scales with ATR, conviction and horizon", () => {
    const low = expectedMovePct({ atrPct: 0.01, conviction: 0.2, horizonDays: 10 });
    const high = expectedMovePct({ atrPct: 0.01, conviction: 0.9, horizonDays: 10 });
    const longer = expectedMovePct({ atrPct: 0.01, conviction: 0.2, horizonDays: 40 });
    expect(high).toBeGreaterThan(low);
    expect(longer).toBeGreaterThan(low);
  });

  it("clamps into a sane band", () => {
    expect(expectedMovePct({ atrPct: 0.0000001, conviction: 0 })).toBe(MIN_EXPECTED_MOVE_PCT);
    expect(expectedMovePct({ atrPct: 5, conviction: 1 })).toBe(MAX_EXPECTED_MOVE_PCT);
  });

  it("falls back to a conservative ATR when unknown", () => {
    expect(expectedMovePct({ atrPct: null, conviction: 0.5 })).toBeGreaterThan(0);
  });
});

describe("assessNetEdge", () => {
  it("blocks a tiny UK single-stock buy the commission floor would eat", () => {
    const r = assessNetEdge({
      symbol: "MKS:xlon",
      side: "buy",
      quantity: 20,
      price: 5,
      assetClass: "stock",
      conviction: 0.6,
      atrPct: 0.012,
    });
    expect(r.pass).toBe(false);
    expect(r.netEdgeBps).toBeLessThan(r.expectedMoveBps);
    expect(r.reason).toMatch(/costs exceed edge/);
  });

  it("charges stamp duty on UK single-stock buys and not on exempt ETFs", () => {
    const stock = assessNetEdge({
      symbol: "MKS:xlon", side: "buy", quantity: 400, price: 5, assetClass: "stock",
      conviction: 0.8, atrPct: 0.02,
    });
    const etf = assessNetEdge({
      symbol: "ISF:xlon", side: "buy", quantity: 400, price: 5, assetClass: "etf",
      conviction: 0.8, atrPct: 0.02,
    });
    expect(stock.costs.stampDuty).toBeGreaterThan(0);
    expect(etf.costs.stampDuty).toBe(0);
    expect(etf.netEdgeBps).toBeGreaterThan(stock.netEdgeBps);
  });

  it("admits a large, high-conviction, high-ATR buy", () => {
    const r = assessNetEdge({
      symbol: "ISF:xlon",
      side: "buy",
      quantity: 2_000,
      price: 5,
      assetClass: "etf",
      conviction: 0.9,
      atrPct: 0.02,
      horizonDays: 15,
    });
    expect(r.pass).toBe(true);
    expect(r.netEdgeBps).toBeGreaterThan(0);
  });

  it("never gates sells", () => {
    const r = assessNetEdge({
      symbol: "MKS:xlon", side: "sell", quantity: 1, price: 1,
      conviction: 0, atrPct: 0.001,
    });
    expect(r.pass).toBe(true);
  });

  it("uses the safety multiple as the hurdle", () => {
    const args = {
      symbol: "ISF:xlon", side: "buy" as const, quantity: 500, price: 5,
      assetClass: "etf", conviction: 0.5, atrPct: 0.015,
    };
    const strict = assessNetEdge({ ...args, safetyMultiple: 8 });
    const loose = assessNetEdge({ ...args, safetyMultiple: 1 });
    expect(strict.pass).toBe(false);
    expect(loose.pass).toBe(true);
    expect(assessNetEdge(args).safetyMultiple).toBe(DEFAULT_EDGE_SAFETY_MULTIPLE);
  });

  it("rejects zero notional", () => {
    const r = assessNetEdge({ symbol: "ISF:xlon", side: "buy", quantity: 0, price: 5 });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("zero notional");
  });
});
