import { describe, it, expect } from "vitest";
import { runBacktest, type BacktestBar, type BacktestStrategy } from "../backtest-runner";
import type { SimDecision, SimState } from "../broker-simulator";

const initial: SimState = { cash: 1000, holdings: [] };

function bars(rows: Array<[string, Record<string, number>]>): BacktestBar[] {
  return rows.map(([date, closes]) => ({ date, closes }));
}

const buyOnce = (day: string, symbol: string, qty: number): BacktestStrategy => (ctx) =>
  ctx.date === day
    ? [{ id: `${day}-${symbol}`, symbol, side: "BUY", quantity: qty, price: ctx.closes[symbol] }]
    : [];

describe("runBacktest", () => {
  it("produces an equity point for every bar even on no-trade days", async () => {
    const res = await runBacktest(
      initial,
      bars([
        ["2020-01-02", { SPY: 100 }],
        ["2020-01-03", { SPY: 101 }],
        ["2020-01-06", { SPY: 102 }],
      ]),
      () => [],
    );
    expect(res.equityCurve).toHaveLength(3);
    expect(res.equityCurve.every((p) => p.totalValue === 1000)).toBe(true);
    expect(res.snapshots).toHaveLength(0);
  });

  it("stamps snapshots with the bar date and index", async () => {
    const res = await runBacktest(
      initial,
      bars([
        ["2020-01-02", { AAPL: 50 }],
        ["2020-01-03", { AAPL: 55 }],
      ]),
      buyOnce("2020-01-02", "AAPL", 4),
    );
    expect(res.snapshots).toHaveLength(1);
    expect(res.snapshots[0]).toMatchObject({
      date: "2020-01-02",
      barIndex: 0,
      fillPrice: 50,
      fillQuantity: 4,
      cash: 800,
    });
    // day 2 mark-to-market at 55: 4*55 + 800 cash = 1020
    expect(res.equityCurve[1].totalValue).toBeCloseTo(1020, 6);
  });

  it("defaults execution price to the bar close", async () => {
    const strat: BacktestStrategy = (ctx) =>
      ctx.barIndex === 0
        ? [{ id: "x", symbol: "SPY", side: "BUY", quantity: 2, price: Number.NaN }]
        : [];
    const res = await runBacktest(
      initial,
      bars([["2020-01-02", { SPY: 100 }]]),
      strat,
    );
    expect(res.snapshots[0].fillPrice).toBe(100);
    expect(res.snapshots[0].cash).toBe(800);
  });

  it("enforces no-borrow: a BUY beyond cash is truncated by default", async () => {
    const res = await runBacktest(
      { cash: 100, holdings: [] },
      bars([["2020-01-02", { X: 40 }]]),
      () => [{ id: "b", symbol: "X", side: "BUY", quantity: 10, price: 40 }],
    );
    // 100 / 40 = 2.5 shares affordable → truncated (fractional allowed)
    expect(res.snapshots[0].fillQuantity).toBeCloseTo(2.5, 8);
    expect(res.finalState.cash).toBeCloseTo(0, 8);
    expect(res.finalState.holdings[0].quantity).toBeCloseTo(2.5, 8);
  });

  it("rejects overspends when simulator options disable truncation", async () => {
    const res = await runBacktest(
      { cash: 100, holdings: [] },
      bars([["2020-01-02", { X: 40 }]]),
      () => [{ id: "b", symbol: "X", side: "BUY", quantity: 10, price: 40 }],
      { simulator: { truncateBuysToCash: false } },
    );
    expect(res.snapshots).toHaveLength(0);
    expect(res.rejections).toHaveLength(1);
    expect(res.rejections[0].reason).toBe("would_borrow");
    expect(res.rejections[0].date).toBe("2020-01-02");
  });

  it("keeps history rolling and monotonic", async () => {
    const seen: number[][] = [];
    const strat: BacktestStrategy = (ctx) => {
      seen.push([...(ctx.history.SPY ?? [])]);
      return [];
    };
    await runBacktest(
      initial,
      bars([
        ["2020-01-02", { SPY: 100 }],
        ["2020-01-03", { SPY: 101 }],
        ["2020-01-06", { SPY: 99 }],
      ]),
      strat,
    );
    expect(seen).toEqual([[100], [100, 101], [100, 101, 99]]);
  });

  it("total_value invariant holds after every step: cash + holdingsValue", async () => {
    const strat: BacktestStrategy = (ctx) => {
      if (ctx.barIndex === 0) return [{ id: "b1", symbol: "A", side: "BUY", quantity: 3, price: 20 }];
      if (ctx.barIndex === 2) return [{ id: "s1", symbol: "A", side: "SELL", quantity: 1, price: 25 }];
      return [];
    };
    const res = await runBacktest(
      { cash: 500, holdings: [] },
      bars([
        ["2021-05-03", { A: 20 }],
        ["2021-05-04", { A: 22 }],
        ["2021-05-05", { A: 25 }],
      ]),
      strat,
    );
    for (const snap of res.snapshots) {
      expect(snap.totalValue).toBeCloseTo(snap.cash + snap.holdingsValue, 8);
    }
    // realized PnL on the sell = (25 - 20) * 1 = 5
    const sell = res.snapshots.find((s) => s.decisionId === "s1");
    expect(sell?.realizedPnl).toBeCloseTo(5, 8);
  });

  it("rejects non-chronological bars", async () => {
    await expect(
      runBacktest(
        initial,
        bars([
          ["2020-01-03", { SPY: 100 }],
          ["2020-01-02", { SPY: 101 }],
        ]),
        () => [],
      ),
    ).rejects.toThrow(/chronological/);
  });

  it("preserves determinism: same inputs → identical outputs", async () => {
    const barSet = bars([
      ["2020-01-02", { A: 10, B: 20 }],
      ["2020-01-03", { A: 11, B: 19 }],
      ["2020-01-06", { A: 12, B: 18 }],
    ]);
    const strat: BacktestStrategy = (ctx) =>
      ctx.barIndex === 0
        ? [
            { id: "a", symbol: "A", side: "BUY", quantity: 5, price: 10 },
            { id: "b", symbol: "B", side: "BUY", quantity: 2, price: 20 },
          ]
        : [];
    const r1 = await runBacktest(initial, barSet, strat);
    const r2 = await runBacktest(initial, barSet, strat);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
