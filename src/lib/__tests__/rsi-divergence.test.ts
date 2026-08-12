import { describe, expect, it } from "vitest";

import { computeRsiSeries, type HistoryPoint } from "@/lib/market-symbol-history";
import { detectRsiDivergences, findPivots } from "@/lib/rsi-divergence";

function toPoints(closes: number[]): HistoryPoint[] {
  const rsi = computeRsiSeries(closes);
  return closes.map((close, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    close,
    indexed: (close / closes[0]) * 100,
    sma20: null,
    sma50: null,
    sma100: null,
    sma200: null,
    rsi14: rsi[i],
  }));
}

/** Zig-zag builder: alternating legs of the given percentage moves. */
function zigzag(start: number, legs: { pct: number; bars: number }[]): number[] {
  const out = [start];
  let v = start;
  for (const leg of legs) {
    const step = (v * leg.pct) / 100 / leg.bars;
    for (let i = 0; i < leg.bars; i++) {
      v += step;
      out.push(v);
    }
  }
  return out;
}

describe("findPivots", () => {
  it("marks confirmed fractal lows and highs", () => {
    const closes = [10, 9, 8, 7, 8, 9, 10, 11, 12, 11, 10, 9];
    const pivots = findPivots(closes, 3);
    expect(pivots).toContainEqual({ index: 3, kind: "low" });
    expect(pivots).toContainEqual({ index: 8, kind: "high" });
  });

  it("never marks the last `lookaround` bars", () => {
    const closes = [5, 4, 3, 2, 1];
    expect(findPivots(closes, 3)).toEqual([]);
  });
});

describe("detectRsiDivergences", () => {
  it("finds a bullish divergence when price makes a lower low but RSI does not", () => {
    // Long slide (RSI deeply oversold), bounce, then a shallower new low.
    const closes = zigzag(100, [
      { pct: -30, bars: 30 },
      { pct: 12, bars: 10 },
      { pct: -13, bars: 12 },
      { pct: 8, bars: 10 },
    ]);
    const found = detectRsiDivergences(toPoints(closes));
    const bullish = found.filter((d) => d.kind === "bullish");
    expect(bullish.length).toBeGreaterThan(0);
    const d = bullish[0];
    expect(d.to.price).toBeLessThan(d.from.price);
    expect(d.to.rsi).toBeGreaterThan(d.from.rsi);
  });

  it("finds a bearish divergence when price makes a higher high but RSI does not", () => {
    const closes = zigzag(100, [
      { pct: 40, bars: 30 },
      { pct: -10, bars: 10 },
      { pct: 14, bars: 12 },
      { pct: -8, bars: 10 },
    ]);
    const found = detectRsiDivergences(toPoints(closes));
    const bearish = found.filter((d) => d.kind === "bearish");
    expect(bearish.length).toBeGreaterThan(0);
    const d = bearish[0];
    expect(d.to.price).toBeGreaterThan(d.from.price);
    expect(d.to.rsi).toBeLessThan(d.from.rsi);
  });

  it("reports nothing when price and momentum agree", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 * 1.004 ** i);
    expect(detectRsiDivergences(toPoints(closes))).toEqual([]);
  });

  it("ignores pivot pairs that are too close or too far apart", () => {
    const closes = zigzag(100, [
      { pct: -30, bars: 30 },
      { pct: 12, bars: 10 },
      { pct: -13, bars: 12 },
      { pct: 8, bars: 10 },
    ]);
    expect(detectRsiDivergences(toPoints(closes), { minGap: 500 })).toEqual([]);
    expect(detectRsiDivergences(toPoints(closes), { maxGap: 1 })).toEqual([]);
  });

  it("handles short windows without throwing", () => {
    expect(detectRsiDivergences(toPoints([1, 2, 3]))).toEqual([]);
    expect(detectRsiDivergences([])).toEqual([]);
  });
});
