import { describe, expect, it } from "vitest";
import {
  buildSymbolHistory,
  coerceRange,
  isKnownSymbol,
  rangeLabel,
  symbolMeta,
} from "../market-symbol-history";

function tape(days: number, start = 100, step = 1) {
  const rows = [];
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < days; i++) {
    rows.push({
      symbol: "SPY",
      price_date: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
      close: start + i * step,
    });
  }
  return rows;
}

describe("market-symbol-history", () => {
  it("only allows symbols shown in Market pulse", () => {
    expect(isKnownSymbol("SPY")).toBe(true);
    expect(isKnownSymbol("^VIX")).toBe(true);
    expect(isKnownSymbol("XLK")).toBe(true);
    expect(isKnownSymbol("NOT-A-SYMBOL")).toBe(false);
    expect(symbolMeta("XLK")?.kind).toBe("US sector");
  });

  it("coerces range search params to a supported window", () => {
    expect(coerceRange("30")).toBe(30);
    expect(coerceRange(365)).toBe(365);
    expect(coerceRange("nonsense")).toBe(90);
    expect(coerceRange(undefined)).toBe(90);
    expect(rangeLabel(1095)).toBe("3y");
    expect(rangeLabel(30)).toBe("30d");
  });

  it("cuts the window by calendar days and indexes to 100", () => {
    const h = buildSymbolHistory("SPY", tape(400), 30);
    expect(h.points.length).toBe(31);
    expect(h.points[0].indexed).toBe(100);
    expect(h.changePct).toBeGreaterThan(0);
    expect(h.maxDrawdownPct).toBe(0);
  });

  it("populates the 200-day average from the first visible point", () => {
    const h = buildSymbolHistory("SPY", tape(400), 30);
    expect(h.points[0].sma200).not.toBeNull();
    expect(h.aboveSma50).toBe(true);
    expect(h.aboveSma200).toBe(true);
  });

  it("reports the worst peak-to-trough fall inside the window", () => {
    const rising = tape(60);
    const falling = rising.map((r, i) => (i >= 40 ? { ...r, close: r.close * 0.8 } : r));
    const h = buildSymbolHistory("SPY", falling, 90);
    expect(h.maxDrawdownPct).toBeLessThan(-15);
    expect(h.low).toBeLessThan(h.high!);
  });

  it("degrades safely with no rows", () => {
    const h = buildSymbolHistory("SPY", [], 90);
    expect(h.points).toEqual([]);
    expect(h.last).toBeNull();
    expect(h.changePct).toBeNull();
    expect(h.volatilityPct).toBeNull();
  });
});

describe("selectable SMA periods", () => {
  const rows = Array.from({ length: 260 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1));
    d.setUTCDate(d.getUTCDate() + i);
    return { price_date: d.toISOString().slice(0, 10), close: 100 + i };
  });

  const history = buildSymbolHistory("SPY", rows, 30);

  it("computes every supported average on each point", () => {
    const lastPoint = history.points[history.points.length - 1];
    for (const p of SMA_PERIODS) {
      const value = lastPoint[smaKey(p)];
      expect(value).not.toBeNull();
      // On a +1/day ramp the trailing mean sits (p-1)/2 below the last close.
      expect(value).toBeCloseTo(lastPoint.close - (p - 1) / 2, 6);
    }
  });

  it("summarises latest values and above/below flags per period", () => {
    for (const p of SMA_PERIODS) {
      expect(history.smaLatest[p]).toBeCloseTo(history.points.at(-1)![smaKey(p)]!, 6);
      expect(history.aboveSma[p]).toBe(true);
    }
    expect(history.smaLatest[50]).toBe(history.sma50);
    expect(history.smaLatest[200]).toBe(history.sma200);
  });

  it("returns nulls for periods longer than the available tape", () => {
    const short = buildSymbolHistory("SPY", rows.slice(0, 30), 30);
    expect(short.smaLatest[20]).not.toBeNull();
    expect(short.smaLatest[100]).toBeNull();
    expect(short.aboveSma[200]).toBeNull();
  });
});
