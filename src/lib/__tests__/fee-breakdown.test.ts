import { describe, expect, it } from "vitest";
import { computeFeeBreakdown } from "@/lib/fee-breakdown";
import { estimateSaxoCommission } from "@/lib/saxo-fees";

describe("computeFeeBreakdown", () => {
  it("returns an empty breakdown for no trades", () => {
    const b = computeFeeBreakdown([]);
    expect(b.summary.tradeCount).toBe(0);
    expect(b.summary.totalCommissions).toBe(0);
    expect(b.roundTrips).toEqual([]);
  });

  it("matches Saxo fee estimator per trade", () => {
    const b = computeFeeBreakdown([
      { trade_date: "2026-01-02", side: "buy", symbol: "AAPL", quantity: 10, price: 200, instrument_ccy: "USD" },
    ]);
    const est = estimateSaxoCommission({ notional: 2000, currency: "USD", symbol: "AAPL" });
    expect(b.perTrade[0].commission).toBeCloseTo(est.commission, 8);
    expect(b.summary.totalCommissions).toBeCloseTo(est.commission, 8);
    expect(b.summary.overallFeeDragBps).toBeCloseTo((est.commission / 2000) * 10_000, 6);
  });

  it("computes round-trip net = gross − buyFee − sellFee via FIFO matching", () => {
    const b = computeFeeBreakdown([
      { trade_date: "2026-01-02", side: "buy", symbol: "MSFT", quantity: 100, price: 400, instrument_ccy: "USD" },
      { trade_date: "2026-01-05", side: "sell", symbol: "MSFT", quantity: 100, price: 410, instrument_ccy: "USD" },
    ]);
    expect(b.roundTrips).toHaveLength(1);
    const [rt] = b.roundTrips;
    expect(rt.grossPnl).toBeCloseTo(1000, 6);
    const buyFee = estimateSaxoCommission({ notional: 40_000, currency: "USD", symbol: "MSFT" }).commission;
    const sellFee = estimateSaxoCommission({ notional: 41_000, currency: "USD", symbol: "MSFT" }).commission;
    expect(rt.totalFee).toBeCloseTo(buyFee + sellFee, 6);
    expect(rt.netPnl).toBeCloseTo(1000 - (buyFee + sellFee), 6);
    expect(b.summary.closedNetPnl).toBeCloseTo(rt.netPnl, 6);
    expect(b.summary.closedGrossPnl).toBeCloseTo(1000, 6);
  });

  it("splits fees pro-rata across partial FIFO fills", () => {
    const b = computeFeeBreakdown([
      { trade_date: "2026-01-02", side: "buy", symbol: "AAPL", quantity: 100, price: 100, instrument_ccy: "USD" },
      { trade_date: "2026-01-03", side: "sell", symbol: "AAPL", quantity: 40, price: 110, instrument_ccy: "USD" },
      { trade_date: "2026-01-04", side: "sell", symbol: "AAPL", quantity: 60, price: 90, instrument_ccy: "USD" },
    ]);
    expect(b.roundTrips).toHaveLength(2);
    const buyFee = estimateSaxoCommission({ notional: 100 * 100, currency: "USD", symbol: "AAPL" }).commission;
    // 40 % of buy fee to first, 60 % to second.
    expect(b.roundTrips[0].buyFee).toBeCloseTo(buyFee * 0.4, 6);
    expect(b.roundTrips[1].buyFee).toBeCloseTo(buyFee * 0.6, 6);
    // Net should equal gross minus split fees.
    for (const r of b.roundTrips) {
      expect(r.netPnl).toBeCloseTo(r.grossPnl - r.totalFee, 6);
    }
  });

  it("flags trades where the min-fee floor sets the commission", () => {
    const b = computeFeeBreakdown([
      { trade_date: "2026-01-02", side: "buy", symbol: "TSCO.L", quantity: 1, price: 10, instrument_ccy: "GBP" },
    ]);
    expect(b.perTrade[0].minFloorApplied).toBe(true);
    expect(b.summary.minFloorTradeCount).toBe(1);
  });

  it("ignores unmatched sells (no open buy lot) and keeps summary sane", () => {
    const b = computeFeeBreakdown([
      { trade_date: "2026-01-02", side: "sell", symbol: "AAPL", quantity: 10, price: 200, instrument_ccy: "USD" },
    ]);
    expect(b.roundTrips).toHaveLength(0);
    expect(b.summary.closedRoundTrips).toBe(0);
    expect(b.summary.totalSellNotional).toBeCloseTo(2000, 6);
  });
});
