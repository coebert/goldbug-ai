import { describe, expect, it } from "vitest";

import {
  TRADE_FOCUS_MIN_BARS,
  clipOverlayToWindow,
  focusOpacity,
  focusPoints,
  isFocused,
  type TradeFocus,
} from "../trade-focus";
import type { HistoryPoint } from "../market-symbol-history";
import type { TradeOverlay } from "../backtest-trade-markers";

function tape(n: number): HistoryPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    close: 100 + i,
  })) as HistoryPoint[];
}

const focus: TradeFocus = {
  tradeId: "rsi:2026-01-20:2026-01-25",
  fromDate: "2026-01-20",
  toDate: "2026-01-25",
  label: "trade",
};

describe("focusPoints", () => {
  it("returns the full tape when nothing is selected", () => {
    const points = tape(30);
    expect(focusPoints(points, null)).toBe(points);
  });

  it("zooms to a padded window around entry and exit", () => {
    const out = focusPoints(tape(31), focus, 3);
    expect(out[0]!.date).toBe("2026-01-17");
    expect(out[out.length - 1]!.date).toBe("2026-01-28");
    expect(out.some((p) => p.date === "2026-01-20")).toBe(true);
    expect(out.some((p) => p.date === "2026-01-25")).toBe(true);
  });

  it("widens a too-tight window to stay readable", () => {
    const tight: TradeFocus = { ...focus, fromDate: "2026-01-20", toDate: "2026-01-21" };
    const out = focusPoints(tape(31), tight, 0);
    expect(out.length).toBeGreaterThanOrEqual(TRADE_FOCUS_MIN_BARS);
  });

  it("falls back to the full tape when the trade is off this window", () => {
    const points = tape(10);
    expect(focusPoints(points, focus)).toBe(points);
  });
});

describe("clipOverlayToWindow", () => {
  const overlay: TradeOverlay = {
    markers: [
      { key: "a", tradeId: "t1", date: "2026-01-05", price: 1, rsi: null, side: "entry", direction: "long", glyph: "B", tone: "neutral", detail: "" },
      { key: "b", tradeId: "t2", date: "2026-01-22", price: 1, rsi: null, side: "entry", direction: "long", glyph: "B", tone: "neutral", detail: "" },
    ],
    legs: [
      { key: "l1", tradeId: "t1", fromDate: "2026-01-05", fromPrice: 1, toDate: "2026-01-06", toPrice: 2, direction: "long", netReturn: 0.1, open: false },
      { key: "l2", tradeId: "t2", fromDate: "2026-01-22", fromPrice: 1, toDate: "2026-01-24", toPrice: 2, direction: "long", netReturn: 0.1, open: false },
    ],
  };

  it("keeps only fills inside the visible window", () => {
    const window = focusPoints(tape(31), focus, 3);
    const clipped = clipOverlayToWindow(overlay, window);
    expect(clipped.markers.map((m) => m.tradeId)).toEqual(["t2"]);
    expect(clipped.legs.map((l) => l.tradeId)).toEqual(["t2"]);
  });
});

describe("focus emphasis", () => {
  it("marks only the selected trade as focused", () => {
    expect(isFocused(focus, focus.tradeId)).toBe(true);
    expect(isFocused(focus, "other")).toBe(false);
    expect(isFocused(null, "other")).toBe(false);
  });

  it("dims unselected fills but leaves everything solid with no selection", () => {
    expect(focusOpacity(null, "x")).toBe(1);
    expect(focusOpacity(focus, focus.tradeId)).toBe(1);
    expect(focusOpacity(focus, "x")).toBeLessThan(0.5);
  });
});
