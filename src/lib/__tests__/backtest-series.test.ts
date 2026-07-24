import { describe, it, expect } from "vitest";
import {
  buildHoldingsOverTime,
  indexPricesForward,
  tailEquity,
  type PriceRow,
  type TradeRow,
} from "@/lib/backtest-series";

const price = (symbol: string, date: string, close: number): PriceRow => ({
  symbol,
  price_date: date,
  close,
});

describe("indexPricesForward", () => {
  it("carries the last close forward when a date is missing", () => {
    const idx = indexPricesForward(
      [price("AAA", "2024-01-01", 10), price("AAA", "2024-01-03", 12)],
      ["AAA"],
      ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"],
    );
    const per = idx.get("AAA")!;
    expect(per.get("2024-01-01")).toBe(10);
    expect(per.get("2024-01-02")).toBe(10);
    expect(per.get("2024-01-03")).toBe(12);
    expect(per.get("2024-01-04")).toBe(12);
  });

  it("omits dates before the first known close", () => {
    const idx = indexPricesForward(
      [price("BBB", "2024-01-05", 20)],
      ["BBB"],
      ["2024-01-01", "2024-01-05"],
    );
    const per = idx.get("BBB")!;
    expect(per.has("2024-01-01")).toBe(false);
    expect(per.get("2024-01-05")).toBe(20);
  });
});

describe("buildHoldingsOverTime", () => {
  it("folds trades and marks positions to close at each snapshot", () => {
    const trades: TradeRow[] = [
      { trade_date: "2024-01-02", side: "buy", symbol: "AAA", quantity: 10, price: 100 },
      { trade_date: "2024-01-04", side: "sell", symbol: "AAA", quantity: 4, price: 130 },
    ];
    const prices: PriceRow[] = [
      price("AAA", "2024-01-02", 100),
      price("AAA", "2024-01-03", 110),
      price("AAA", "2024-01-04", 130),
    ];
    const { symbols, points } = buildHoldingsOverTime(
      trades,
      ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"],
      prices,
      2000,
    );

    expect(symbols).toEqual(["AAA"]);
    expect(points).toHaveLength(4);
    // Pre-trade: only cash.
    expect(points[0]).toMatchObject({ date: "2024-01-01", cash: 2000, AAA: 0, total: 2000 });
    // Buy day: 10 @ 100 → cash 1000, position marked at 100 → 1000.
    expect(points[1]).toMatchObject({ date: "2024-01-02", cash: 1000, AAA: 1000, total: 2000 });
    // Hold day: position marked at 110 → 1100.
    expect(points[2]).toMatchObject({ date: "2024-01-03", cash: 1000, AAA: 1100, total: 2100 });
    // Sell day: 4 @ 130 → cash 1000 + 520 = 1520, holds 6 @ 130 = 780.
    expect(points[3]).toMatchObject({ date: "2024-01-04", cash: 1520, AAA: 780, total: 2300 });
  });

  it("drops symbols that never held any positive value in the window", () => {
    const trades: TradeRow[] = [
      { trade_date: "2024-01-02", side: "buy", symbol: "AAA", quantity: 1, price: 50 },
      { trade_date: "2024-01-02", side: "sell", symbol: "ZZZ", quantity: 1, price: 50 },
    ];
    const prices: PriceRow[] = [price("AAA", "2024-01-02", 50), price("ZZZ", "2024-01-02", 50)];
    const { symbols } = buildHoldingsOverTime(
      trades,
      ["2024-01-01", "2024-01-02"],
      prices,
      100,
    );
    expect(symbols).toEqual(["AAA"]);
  });

  it("uses executed_at as tiebreaker within a date", () => {
    const trades: TradeRow[] = [
      { trade_date: "2024-01-02", executed_at: "2024-01-02T12:00:00Z", side: "sell", symbol: "AAA", quantity: 5, price: 100 },
      { trade_date: "2024-01-02", executed_at: "2024-01-02T09:00:00Z", side: "buy", symbol: "AAA", quantity: 5, price: 100 },
      // Keep AAA visible in the series by also holding some overnight.
      { trade_date: "2024-01-02", executed_at: "2024-01-02T09:30:00Z", side: "buy", symbol: "AAA", quantity: 1, price: 100 },
    ];
    const prices: PriceRow[] = [price("AAA", "2024-01-02", 100)];
    const { points } = buildHoldingsOverTime(trades, ["2024-01-02"], prices, 500);
    // Net position: +5 -5 +1 = 1 share @ 100 = 100.
    expect(points[0].AAA).toBe(100);
    expect(points[0].cash).toBe(400);
  });
});

describe("tailEquity", () => {
  it("returns the last N points; passthrough when shorter", () => {
    const eq = [1, 2, 3, 4, 5].map((v, i) => ({
      snapshot_date: `2024-01-0${i + 1}`,
      total_value: v * 100,
    }));
    expect(tailEquity(eq, 3).map((r) => r.total_value)).toEqual([300, 400, 500]);
    expect(tailEquity(eq, 10)).toHaveLength(5);
  });
});
