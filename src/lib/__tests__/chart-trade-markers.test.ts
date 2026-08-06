import { describe, it, expect } from "vitest";
import {
  attachTradeMarkers,
  bucketTradeMarkers,
  describeMarkerCell,
  tradeTimestamp,
  type MarkerTrade,
} from "../chart-trade-markers";

const t = (
  side: "buy" | "sell",
  date: string,
  symbol = "AAPL",
  qty = 10,
  price = 100,
  executed_at: string | null = null,
): MarkerTrade => ({ side, trade_date: date, symbol, quantity: qty, price, executed_at });

const money = (v: number) => `£${v.toFixed(2)}`;

describe("bucketTradeMarkers", () => {
  const days = ["2026-01-05", "2026-01-06", "2026-01-07"];

  it("snaps a trade onto its own day", () => {
    const m = bucketTradeMarkers(days, [t("buy", "2026-01-06")]);
    expect(m.get("2026-01-06")?.buys).toBe(1);
    expect(m.has("2026-01-05")).toBe(false);
  });

  it("snaps back to the last point at or before the trade", () => {
    const m = bucketTradeMarkers(["2026-01-05", "2026-01-08"], [t("sell", "2026-01-07")]);
    expect(m.get("2026-01-05")?.sells).toBe(1);
  });

  it("snaps a pre-series trade forward to the first point", () => {
    const m = bucketTradeMarkers(days, [t("buy", "2025-12-01")]);
    expect(m.get("2026-01-05")?.buys).toBe(1);
  });

  it("aggregates counts and notional per point", () => {
    const m = bucketTradeMarkers(days, [
      t("buy", "2026-01-06", "AAPL", 10, 100),
      t("buy", "2026-01-06", "MSFT", 2, 50),
      t("sell", "2026-01-06", "TSLA", 1, 200),
    ]);
    const cell = m.get("2026-01-06")!;
    expect(cell.buys).toBe(2);
    expect(cell.sells).toBe(1);
    expect(cell.buyValue).toBe(1100);
    expect(cell.sellValue).toBe(200);
  });

  it("prefers executed_at over trade_date for hourly series", () => {
    const hours = ["2026-01-06T09:00:00Z", "2026-01-06T14:00:00Z"];
    const m = bucketTradeMarkers(hours, [
      t("buy", "2026-01-06", "AAPL", 1, 1, "2026-01-06T15:30:00Z"),
    ]);
    expect(m.get("2026-01-06T14:00:00Z")?.buys).toBe(1);
    expect(tradeTimestamp(t("buy", "2026-01-06", "A", 1, 1, "2026-01-06T15:30:00Z"))).toBe(
      Date.parse("2026-01-06T15:30:00Z"),
    );
  });

  it("ignores unparseable dates and empty series", () => {
    expect(bucketTradeMarkers([], [t("buy", "2026-01-06")]).size).toBe(0);
    expect(bucketTradeMarkers(days, [t("buy", "not-a-date")]).size).toBe(0);
  });
});

describe("attachTradeMarkers", () => {
  const rows = [
    { date: "2026-01-05", equity: 100 },
    { date: "2026-01-06", equity: 110 },
    { date: "2026-01-07", equity: 90 },
  ];

  it("puts markers on the plotted value and nowhere else", () => {
    const out = attachTradeMarkers(rows, "date", "equity", [
      t("buy", "2026-01-05"),
      t("sell", "2026-01-07"),
    ]);
    expect(out[0].buyMark).toBe(100);
    expect(out[0].sellMark).toBeNull();
    expect(out[1].buyMark).toBeNull();
    expect(out[1].marker).toBeNull();
    expect(out[2].sellMark).toBe(90);
  });

  it("marks both sides when a bar has a buy and a sell", () => {
    const out = attachTradeMarkers(rows, "date", "equity", [
      t("buy", "2026-01-06"),
      t("sell", "2026-01-06"),
    ]);
    expect(out[1].buyMark).toBe(110);
    expect(out[1].sellMark).toBe(110);
  });

  it("keeps the original row fields", () => {
    const out = attachTradeMarkers(rows, "date", "equity", []);
    expect(out.map((r) => r.equity)).toEqual([100, 110, 90]);
    expect(out.every((r) => r.marker === null)).toBe(true);
  });
});

describe("describeMarkerCell", () => {
  it("renders one line per trade with side, symbol, qty and price", () => {
    const cell = bucketTradeMarkers(["2026-01-06"], [
      t("buy", "2026-01-06", "AAPL", 10, 123.45),
      t("sell", "2026-01-06", "MSFT", 3, 50),
    ]).get("2026-01-06")!;
    expect(describeMarkerCell(cell, money)).toEqual([
      "▲ BUY AAPL · 10 @ £123.45",
      "▼ SELL MSFT · 3 @ £50.00",
    ]);
  });

  it("truncates long lists with a +n more line", () => {
    const trades = Array.from({ length: 6 }, (_, i) => t("buy", "2026-01-06", `S${i}`));
    const cell = bucketTradeMarkers(["2026-01-06"], trades).get("2026-01-06")!;
    const lines = describeMarkerCell(cell, money, 4);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("+2 more");
  });

  it("returns nothing for an empty cell", () => {
    expect(describeMarkerCell(null, money)).toEqual([]);
  });
});
