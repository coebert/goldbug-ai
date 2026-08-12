import { describe, expect, it } from "vitest";

import { backtestRsiStrategy } from "@/lib/rsi-backtest";
import type { HistoryPoint } from "@/lib/market-symbol-history";

function pt(date: string, close: number, rsi: number | null): HistoryPoint {
  return { date, close, rsi14: rsi } as HistoryPoint;
}

const series = [
  pt("2026-01-01", 100, 50),
  pt("2026-01-02", 90, 25), // oversold touch
  pt("2026-01-03", 95, 41), // cross buy
  pt("2026-01-04", 105, 60),
  pt("2026-01-05", 120, 75), // overbought touch
  pt("2026-01-06", 118, 64), // cross sell
];

describe("backtestRsiStrategy", () => {
  it("runs a round trip on cross logic net of friction", () => {
    const r = backtestRsiStrategy(series, "cross", { frictionBps: 0 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ entryDate: "2026-01-03", exitDate: "2026-01-06", open: false });
    expect(r.totalReturn).toBeCloseTo(118 / 95 - 1, 6);
    expect(r.winRate).toBe(1);
  });

  it("charges friction against the trade return", () => {
    const free = backtestRsiStrategy(series, "cross", { frictionBps: 0 }).totalReturn;
    const costly = backtestRsiStrategy(series, "cross", { frictionBps: 100 }).totalReturn;
    expect(costly).toBeLessThan(free);
  });

  it("closes an open position at the last bar", () => {
    const r = backtestRsiStrategy(series.slice(0, 4), "cross", { frictionBps: 0 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]?.open).toBe(true);
  });

  it("reports buy-and-hold for context", () => {
    const r = backtestRsiStrategy(series, "touch");
    expect(r.buyHoldReturn).toBeCloseTo(118 / 100 - 1, 6);
  });

  it("measures max drawdown on the equity curve", () => {
    const dip = [
      pt("2026-02-01", 100, 50),
      pt("2026-02-02", 100, 25),
      pt("2026-02-03", 100, 41), // buy at 100
      pt("2026-02-04", 70, 45), // -30% while held
      pt("2026-02-05", 100, 75),
      pt("2026-02-06", 100, 60), // sell flat
    ];
    const r = backtestRsiStrategy(dip, "cross", { frictionBps: 0 });
    expect(r.maxDrawdown).toBeCloseTo(0.3, 2);
  });

  it("returns zeros when no signals fire", () => {
    const flat = [pt("2026-03-01", 10, 50), pt("2026-03-02", 11, 51)];
    const r = backtestRsiStrategy(flat, "cross");
    expect(r.trades).toHaveLength(0);
    expect(r.totalReturn).toBe(0);
    expect(r.winRate).toBe(0);
    expect(r.exposure).toBe(0);
  });
});
