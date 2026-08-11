import { describe, it, expect } from "vitest";
import { stochastic, type StochasticSnapshot } from "@/lib/signals-extended.server";
import { stochasticEntryTiming } from "@/lib/alpha/stochastic-timing";
import type { Candle } from "@/lib/market-data.server";

function candles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: 1000,
  }));
}

const base: StochasticSnapshot = {
  k: 50,
  d: 50,
  oversold: false,
  overbought: false,
  bull_cross: false,
  bear_cross: false,
  bull_cross_from_oversold: false,
  rising: true,
};

describe("stochastic()", () => {
  it("returns null when history is too short", () => {
    expect(stochastic(candles([1, 2, 3, 4, 5]))).toBeNull();
  });

  it("pins %K near 100 at the top of the range and near 0 at the bottom", () => {
    const up = stochastic(candles(Array.from({ length: 40 }, (_, i) => 100 + i)));
    const down = stochastic(candles(Array.from({ length: 40 }, (_, i) => 140 - i)));
    expect(up!.k).toBeGreaterThan(80);
    expect(up!.overbought).toBe(true);
    expect(down!.k).toBeLessThan(20);
    expect(down!.oversold).toBe(true);
  });

  it("keeps %K and %D inside [0, 100] on noisy data", () => {
    const noisy = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 8);
    const s = stochastic(candles(noisy))!;
    for (const v of [s.k, s.d]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("treats a flat (zero-range) window as mid-range instead of NaN", () => {
    const flat = candles(Array.from({ length: 40 }, () => 100)).map((c) => ({
      ...c,
      high: 100,
      low: 100,
    }));
    const s = stochastic(flat)!;
    expect(s.k).toBeCloseTo(50, 6);
    expect(Number.isNaN(s.d)).toBe(false);
  });

  it("flags a bullish cross when %K turns up through %D", () => {
    const closes = [
      ...Array.from({ length: 30 }, (_, i) => 120 - i * 2), // long slide → oversold
      62,
      66,
      70,
    ];
    const s = stochastic(candles(closes))!;
    expect(s.rising).toBe(true);
    expect(s.bull_cross).toBe(true);
  });
});

describe("stochasticEntryTiming()", () => {
  it("passes through untouched when no data is available", () => {
    const t = stochasticEntryTiming(null);
    expect(t).toMatchObject({ multiplier: 1, allow: true });
  });

  it("allows full size on a bull cross out of oversold", () => {
    const t = stochasticEntryTiming({
      ...base,
      k: 24,
      d: 20,
      bull_cross: true,
      bull_cross_from_oversold: true,
    });
    expect(t.multiplier).toBe(1);
    expect(t.allow).toBe(true);
  });

  it("blocks buys when overbought and rolling over", () => {
    const t = stochasticEntryTiming({
      ...base,
      k: 92,
      d: 94,
      overbought: true,
      rising: false,
      bear_cross: true,
    });
    expect(t.allow).toBe(false);
    expect(t.multiplier).toBe(0);
  });

  it("haircuts rather than blocks when configured", () => {
    const t = stochasticEntryTiming(
      { ...base, k: 92, d: 94, overbought: true, rising: false },
      { blockOverboughtRollover: false },
    );
    expect(t.allow).toBe(true);
    expect(t.multiplier).toBeGreaterThan(0);
    expect(t.multiplier).toBeLessThan(1);
  });

  it("part-sizes an overbought but still rising reading", () => {
    const t = stochasticEntryTiming({ ...base, k: 88, d: 84, overbought: true, rising: true });
    expect(t.multiplier).toBeCloseTo(0.7, 6);
  });

  it("part-sizes oversold with no upturn yet", () => {
    const t = stochasticEntryTiming({ ...base, k: 12, d: 15, oversold: true, rising: false });
    expect(t.multiplier).toBeCloseTo(0.8, 6);
  });

  it("never scales above 1 for any reading", () => {
    for (let k = 0; k <= 100; k += 5) {
      for (const rising of [true, false]) {
        const t = stochasticEntryTiming({
          ...base,
          k,
          d: k - 2,
          oversold: k < 20,
          overbought: k > 80,
          rising,
        });
        expect(t.multiplier).toBeLessThanOrEqual(1);
        expect(t.multiplier).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
