import { describe, expect, it } from "vitest";

import {
  RSI_PERIOD,
  buildSymbolHistory,
  computeRsiSeries,
  rsiZone,
} from "../market-symbol-history";

function ramp(n: number, step: number, start = 100): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

describe("computeRsiSeries", () => {
  it("returns nulls until the look-back is warm", () => {
    const out = computeRsiSeries(ramp(20, 1));
    expect(out.slice(0, RSI_PERIOD).every((v) => v === null)).toBe(true);
    expect(out[RSI_PERIOD]).not.toBeNull();
  });

  it("pins to 100 on an unbroken advance and near 0 on an unbroken decline", () => {
    const up = computeRsiSeries(ramp(40, 1));
    expect(up.at(-1)).toBe(100);
    const down = computeRsiSeries(ramp(40, -1, 200));
    expect(down.at(-1)!).toBeLessThan(1);
  });

  it("sits mid-range on alternating moves", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1));
    const v = computeRsiSeries(closes).at(-1)!;
    expect(v).toBeGreaterThan(35);
    expect(v).toBeLessThan(65);
  });

  it("handles series shorter than the period", () => {
    expect(computeRsiSeries([1, 2, 3])).toEqual([null, null, null]);
  });
});

describe("rsiZone", () => {
  it("classifies against the 30/70 bands", () => {
    expect(rsiZone(22)).toBe("oversold");
    expect(rsiZone(30)).toBe("oversold");
    expect(rsiZone(50)).toBe("neutral");
    expect(rsiZone(70)).toBe("overbought");
    expect(rsiZone(84)).toBe("overbought");
    expect(rsiZone(null)).toBeNull();
  });
});

describe("buildSymbolHistory RSI", () => {
  it("attaches rsi14 to points and surfaces the latest reading", () => {
    const rows = ramp(80, 1).map((close, i) => ({
      symbol: "TEST",
      price_date: `2026-0${1 + Math.floor(i / 31)}-${String((i % 31) + 1).padStart(2, "0")}`,
      close,
    }));
    const h = buildSymbolHistory("TEST", rows, 365);
    expect(h.rsi14).toBe(100);
    expect(h.points.at(-1)?.rsi14).toBe(100);
  });
});
