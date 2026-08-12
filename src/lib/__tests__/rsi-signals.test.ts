import { describe, expect, it } from "vitest";

import { detectRsiSignals, rsiSignalSummary } from "@/lib/rsi-signals";
import type { HistoryPoint } from "@/lib/market-symbol-history";

function pt(date: string, close: number, rsi: number | null): HistoryPoint {
  return { date, close, rsi14: rsi } as HistoryPoint;
}

const series = [
  pt("2026-01-01", 100, 50),
  pt("2026-01-02", 96, 28), // enters oversold
  pt("2026-01-03", 95, 25), // still oversold
  pt("2026-01-04", 99, 41), // leaves oversold
  pt("2026-01-05", 108, 72), // enters overbought
  pt("2026-01-06", 110, 78), // still overbought
  pt("2026-01-07", 106, 64), // leaves overbought
];

describe("detectRsiSignals", () => {
  it("touch mode marks zone entries once per episode", () => {
    const s = detectRsiSignals(series, "touch");
    expect(s.map((x) => [x.kind, x.date])).toEqual([
      ["buy", "2026-01-02"],
      ["sell", "2026-01-05"],
    ]);
    expect(s[0]?.price).toBe(96);
  });

  it("cross mode marks zone exits once per episode", () => {
    const s = detectRsiSignals(series, "cross");
    expect(s.map((x) => [x.kind, x.date])).toEqual([
      ["buy", "2026-01-04"],
      ["sell", "2026-01-07"],
    ]);
  });

  it("does not signal on the first readable bar", () => {
    const s = detectRsiSignals([pt("2026-02-01", 10, 22), pt("2026-02-02", 10, 21)], "touch");
    expect(s).toEqual([]);
  });

  it("skips warm-up bars without breaking episode state", () => {
    const gapped = [
      pt("2026-03-01", 10, 50),
      pt("2026-03-02", 9, 25),
      pt("2026-03-03", 9, null),
      pt("2026-03-04", 9, 24),
    ];
    expect(detectRsiSignals(gapped, "touch")).toHaveLength(1);
  });

  it("honours custom thresholds", () => {
    const s = detectRsiSignals(series, "touch", { oversold: 20, overbought: 90 });
    expect(s).toEqual([]);
  });

  it("summarises markers in plain language", () => {
    const [buy] = detectRsiSignals(series, "cross");
    expect(rsiSignalSummary(buy!)).toContain("back above 30");
  });
});
