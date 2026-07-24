import { describe, it, expect } from "vitest";
import { runBacktest, type BacktestBar, type BacktestStrategy } from "../backtest-runner";
import { buildStrategyReport } from "../strategy-report";
import type { SimState } from "../broker-simulator";

const initial: SimState = { cash: 1000, holdings: [] };
const bars = (rows: Array<[string, Record<string, number>]>): BacktestBar[] =>
  rows.map(([date, closes]) => ({ date, closes }));

describe("buildStrategyReport", () => {
  it("reports zeros for an idle strategy (no trades, flat cash)", async () => {
    const res = await runBacktest(
      initial,
      bars([
        ["2020-01-02", { SPY: 100 }],
        ["2020-01-03", { SPY: 105 }],
        ["2020-01-06", { SPY: 110 }],
      ]),
      () => [],
    );
    const r = buildStrategyReport(res);
    expect(r.period).toEqual({
      startDate: "2020-01-02",
      endDate: "2020-01-06",
      bars: 3,
      years: 2 / 252,
    });
    expect(r.returns.totalReturnPct).toBe(0);
    expect(r.trades.total).toBe(0);
    expect(r.trades.wins).toBe(0);
    expect(r.trades.winRatePct).toBeNull();
    expect(r.risk.maxDrawdownPct).toBe(0);
    expect(r.exposure.barsInvestedPct).toBe(0);
    expect(r.exposure.avgCashWeightPct).toBeCloseTo(100, 6);
  });

  it("computes total return and CAGR from a buy-and-hold curve", async () => {
    const strat: BacktestStrategy = (ctx) =>
      ctx.barIndex === 0
        ? [{ id: "b", symbol: "X", side: "BUY", quantity: 10, price: 100 }]
        : [];
    const res = await runBacktest(
      initial,
      bars([
        ["2020-01-02", { X: 100 }],
        ["2020-01-03", { X: 110 }],
        ["2020-01-06", { X: 121 }],
      ]),
      strat,
    );
    const r = buildStrategyReport(res);
    // buy 10 @100 = 1000 cost; final MTM = 10*121 = 1210 + 0 cash
    expect(r.returns.endingEquity).toBeCloseTo(1210, 6);
    expect(r.returns.totalReturnPct).toBeCloseTo(21, 6);
    expect(r.exposure.finalHoldingsCount).toBe(1);
    expect(r.exposure.barsInvestedPct).toBeCloseTo((3 / 3) * 100, 6);
  });

  it("detects max drawdown and records peak/trough dates", async () => {
    // Cash-only "asset" mimic: buy 10 shares @100, then price crashes.
    const strat: BacktestStrategy = (ctx) =>
      ctx.barIndex === 0
        ? [{ id: "b", symbol: "A", side: "BUY", quantity: 10, price: 100 }]
        : [];
    const res = await runBacktest(
      initial,
      bars([
        ["2020-01-02", { A: 100 }],
        ["2020-01-03", { A: 120 }], // peak here (equity 1200)
        ["2020-01-06", { A: 90 }],  // trough here (equity 900) → 25% dd
        ["2020-01-07", { A: 100 }],
      ]),
      strat,
    );
    const r = buildStrategyReport(res);
    expect(r.risk.maxDrawdownPct).toBeCloseTo(25, 6);
    expect(r.risk.maxDrawdownPeakDate).toBe("2020-01-03");
    expect(r.risk.maxDrawdownTroughDate).toBe("2020-01-06");
  });

  it("computes win rate and profit factor from realized SELL PnL", async () => {
    // Two round-trips: one winner, one loser.
    const strat: BacktestStrategy = (ctx) => {
      if (ctx.barIndex === 0) return [{ id: "b1", symbol: "A", side: "BUY", quantity: 5, price: 10 }];
      if (ctx.barIndex === 1) return [{ id: "s1", symbol: "A", side: "SELL", quantity: 5, price: 14 }]; // +20
      if (ctx.barIndex === 2) return [{ id: "b2", symbol: "A", side: "BUY", quantity: 5, price: 20 }];
      if (ctx.barIndex === 3) return [{ id: "s2", symbol: "A", side: "SELL", quantity: 5, price: 18 }]; // -10
      return [];
    };
    const res = await runBacktest(
      { cash: 500, holdings: [] },
      bars([
        ["2021-05-03", { A: 10 }],
        ["2021-05-04", { A: 14 }],
        ["2021-05-05", { A: 20 }],
        ["2021-05-06", { A: 18 }],
      ]),
      strat,
    );
    const r = buildStrategyReport(res);
    expect(r.trades.executed).toBe(4);
    expect(r.trades.sells).toBe(2);
    expect(r.trades.wins).toBe(1);
    expect(r.trades.losses).toBe(1);
    expect(r.trades.winRatePct).toBeCloseTo(50, 6);
    expect(r.trades.grossRealizedPnl).toBeCloseTo(10, 6);
    expect(r.trades.largestWin).toBeCloseTo(20, 6);
    expect(r.trades.largestLoss).toBeCloseTo(-10, 6);
    expect(r.trades.profitFactor).toBeCloseTo(2, 6);
  });

  it("counts rejections separately from executed trades", async () => {
    const res = await runBacktest(
      { cash: 100, holdings: [] },
      bars([["2020-01-02", { X: 40 }]]),
      () => [{ id: "b", symbol: "X", side: "BUY", quantity: 100, price: 40 }],
      { simulator: { truncateBuysToCash: false } },
    );
    const r = buildStrategyReport(res);
    expect(r.trades.executed).toBe(0);
    expect(r.trades.rejected).toBe(1);
    expect(r.trades.total).toBe(1);
  });

  it("Sharpe is null when returns are constant, positive when they trend up", async () => {
    const flat = await runBacktest(initial, bars([
      ["2020-01-02", { A: 100 }],
      ["2020-01-03", { A: 100 }],
      ["2020-01-06", { A: 100 }],
    ]), () => []);
    expect(buildStrategyReport(flat).risk.sharpe).toBeNull();

    const strat: BacktestStrategy = (ctx) =>
      ctx.barIndex === 0
        ? [{ id: "b", symbol: "A", side: "BUY", quantity: 10, price: 100 }]
        : [];
    const up = await runBacktest(initial, bars([
      ["2020-01-02", { A: 100 }],
      ["2020-01-03", { A: 101 }],
      ["2020-01-06", { A: 102 }],
      ["2020-01-07", { A: 103 }],
    ]), strat);
    const r = buildStrategyReport(up);
    expect(r.risk.sharpe).not.toBeNull();
    expect(r.risk.sharpe as number).toBeGreaterThan(0);
  });

  it("is deterministic across repeated evaluations", async () => {
    const strat: BacktestStrategy = (ctx) =>
      ctx.barIndex === 0
        ? [{ id: "b", symbol: "A", side: "BUY", quantity: 3, price: 100 }]
        : ctx.barIndex === 2
          ? [{ id: "s", symbol: "A", side: "SELL", quantity: 3, price: 110 }]
          : [];
    const barsSet = bars([
      ["2020-01-02", { A: 100 }],
      ["2020-01-03", { A: 105 }],
      ["2020-01-06", { A: 110 }],
    ]);
    const r1 = buildStrategyReport(await runBacktest(initial, barsSet, strat));
    const r2 = buildStrategyReport(await runBacktest(initial, barsSet, strat));
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
