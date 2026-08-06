import { describe, it, expect } from "vitest";
import {
  assessTradeViability,
  estimateTradeCosts,
  minViableNotional,
  attractsStampDuty,
  DEFAULT_ROUND_TRIP_BUDGET_BPS,
} from "../trade-viability-gate";

describe("trade viability gate", () => {
  it("blocks the tiny LSE tickets that production was actually firing", () => {
    // 1 share of VMID.L at £36.44 — a real production fill.
    const r = assessTradeViability({
      symbol: "VMID.L",
      side: "buy",
      quantity: 1,
      price: 36.44,
      assetClass: "etf",
    });
    expect(r.viable).toBe(false);
    // £3 floor each way on £36 = >1600bps round trip.
    expect(r.costs.roundTripBps).toBeGreaterThan(1000);
    expect(r.reason).toMatch(/uneconomic ticket/);
  });

  it("allows an economically sized ticket", () => {
    const r = assessTradeViability({
      symbol: "VMID.L",
      side: "buy",
      quantity: 200,
      price: 36.44,
      assetClass: "etf",
    });
    expect(r.viable).toBe(true);
    expect(r.costs.roundTripBps).toBeLessThanOrEqual(DEFAULT_ROUND_TRIP_BUDGET_BPS);
  });

  it("never blocks a sell, however small — exits must always execute", () => {
    const r = assessTradeViability({
      symbol: "MKS.L",
      side: "sell",
      quantity: 1,
      price: 4.04,
    });
    expect(r.viable).toBe(true);
  });

  it("charges UK stamp duty on shares but not on exempt ETFs", () => {
    expect(attractsStampDuty("MKS.L", "stock")).toBe(true);
    expect(attractsStampDuty("VMID.L", "etf")).toBe(false);
    expect(attractsStampDuty("ISF.L", "stock")).toBe(false); // exempt root
    expect(attractsStampDuty("AAPL", "stock")).toBe(false);

    const uk = estimateTradeCosts({
      symbol: "MKS.L",
      side: "buy",
      quantity: 5000,
      price: 4.04,
      assetClass: "stock",
    });
    expect(uk.stampDutyBps).toBeCloseTo(50, 5);
    // > £10k consideration → PTM levy applies.
    expect(uk.ptmLevy).toBe(1);
  });

  it("does not charge stamp duty on sells", () => {
    const sell = estimateTradeCosts({
      symbol: "MKS.L",
      side: "sell",
      quantity: 5000,
      price: 4.04,
      assetClass: "stock",
    });
    expect(sell.stampDuty).toBe(0);
  });

  it("min viable notional is consistent with the gate decision", () => {
    const floor = minViableNotional({ symbol: "VUSA.L", side: "buy", assetClass: "etf" });
    expect(Number.isFinite(floor)).toBe(true);

    const justUnder = assessTradeViability({
      symbol: "VUSA.L",
      side: "buy",
      quantity: 1,
      price: floor * 0.9,
      assetClass: "etf",
    });
    const justOver = assessTradeViability({
      symbol: "VUSA.L",
      side: "buy",
      quantity: 1,
      price: floor * 1.1,
      assetClass: "etf",
    });
    expect(justUnder.viable).toBe(false);
    expect(justOver.viable).toBe(true);
  });

  it("stamp duty alone can make UK shares unviable at a tight budget", () => {
    // 50bps stamp duty > a 40bps budget no matter how big the ticket.
    const floor = minViableNotional({
      symbol: "MKS.L",
      side: "buy",
      assetClass: "stock",
      budgetBps: 40,
    });
    expect(floor).toBe(Infinity);
  });

  it("cost bps fall monotonically as notional grows", () => {
    let prev = Infinity;
    for (const qty of [1, 10, 100, 1000, 10_000]) {
      const c = estimateTradeCosts({ symbol: "AAPL", side: "buy", quantity: qty, price: 200 });
      expect(c.roundTripBps).toBeLessThanOrEqual(prev);
      prev = c.roundTripBps;
    }
  });
});
