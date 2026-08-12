import { describe, expect, it } from "vitest";

import {
  divergenceTradeOverlay,
  mergeTradeOverlays,
  rsiTradeOverlay,
} from "@/lib/backtest-trade-markers";
import type { HistoryPoint } from "@/lib/market-symbol-history";
import type { RsiTrade } from "@/lib/rsi-backtest";
import type { DivergenceTrade } from "@/lib/rsi-divergence-backtest";

const points: HistoryPoint[] = [
  { date: "2026-01-01", close: 100, indexed: 100, sma20: null, sma50: null, sma100: null, sma200: null, rsi14: 28 },
  { date: "2026-01-02", close: 104, indexed: 104, sma20: null, sma50: null, sma100: null, sma200: null, rsi14: 55 },
  { date: "2026-01-03", close: 110, indexed: 110, sma20: null, sma50: null, sma100: null, sma200: null, rsi14: 72 },
];

const rsiTrade: RsiTrade = {
  entryDate: "2026-01-01",
  entryPrice: 100,
  exitDate: "2026-01-03",
  exitPrice: 110,
  netReturn: 0.096,
  bars: 2,
  open: false,
};

const divTrade: DivergenceTrade = {
  kind: "bearish",
  pivotDate: "2026-01-01",
  entryDate: "2026-01-02",
  entryPrice: 104,
  exitDate: "2026-01-03",
  exitPrice: 110,
  bars: 1,
  outcome: "failed",
  netReturn: -0.062,
  mfe: 0,
  mae: 0.058,
  invalidation: 109,
};

describe("rsiTradeOverlay", () => {
  it("emits an entry and an exit marker per trade with the RSI of that bar", () => {
    const { markers, legs } = rsiTradeOverlay([rsiTrade], points);
    expect(markers).toHaveLength(2);
    const [entry, exit] = markers;
    expect(entry.side).toBe("entry");
    expect(entry.direction).toBe("long");
    expect(entry.glyph).toBe("B");
    expect(entry.rsi).toBe(28);
    expect(exit.side).toBe("exit");
    expect(exit.glyph).toBe("S");
    expect(exit.rsi).toBe(72);
    expect(exit.tone).toBe("positive");
    expect(exit.detail).toContain("+9.60%");
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ fromPrice: 100, toPrice: 110, open: false });
  });

  it("labels a still-open position at the window end", () => {
    const { markers } = rsiTradeOverlay([{ ...rsiTrade, open: true }], points);
    expect(markers[1].detail).toContain("Open at window end");
  });

  it("marks a losing exit as negative", () => {
    const { markers } = rsiTradeOverlay([{ ...rsiTrade, netReturn: -0.03 }], points);
    expect(markers[1].tone).toBe("negative");
  });
});

describe("divergenceTradeOverlay", () => {
  it("mirrors the glyphs for short (bearish) setups", () => {
    const { markers, legs } = divergenceTradeOverlay([divTrade], points);
    expect(markers[0].direction).toBe("short");
    expect(markers[0].glyph).toBe("S");
    expect(markers[1].glyph).toBe("B");
    expect(markers[1].tone).toBe("negative");
    expect(markers[1].detail).toContain("failed");
    expect(legs[0].direction).toBe("short");
  });

  it("uses the confirmed entry bar, not the pivot bar", () => {
    const { markers } = divergenceTradeOverlay([divTrade], points);
    expect(markers[0].date).toBe("2026-01-02");
    expect(markers[0].detail).toContain("pivot 2026-01-01");
  });

  it("leaves rsi null when the bar is not in the window", () => {
    const { markers } = divergenceTradeOverlay(
      [{ ...divTrade, entryDate: "2025-12-30" }],
      points,
    );
    expect(markers[0].rsi).toBeNull();
  });
});

describe("mergeTradeOverlays", () => {
  it("concatenates markers and legs with unique keys", () => {
    const merged = mergeTradeOverlays(
      rsiTradeOverlay([rsiTrade], points),
      divergenceTradeOverlay([divTrade], points),
    );
    expect(merged.markers).toHaveLength(4);
    expect(merged.legs).toHaveLength(2);
    expect(new Set(merged.markers.map((m) => m.key)).size).toBe(4);
  });
});
