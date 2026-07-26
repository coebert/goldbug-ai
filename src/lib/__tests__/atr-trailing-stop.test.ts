import { describe, it, expect } from "vitest";
import {
  atr,
  computeTrailingStop,
  advanceTrailingStop,
  DEFAULT_TRAILING_STOP,
  type Bar,
} from "@/lib/exits/atr-trailing-stop";

function trend(n: number, start = 100, step = 1, rangePct = 0.01): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const close = start + i * step;
    const half = close * rangePct;
    out.push({ high: close + half, low: close - half, close });
  }
  return out;
}

describe("ATR trailing stop", () => {
  it("returns null ATR when history is too short", () => {
    expect(atr(trend(5), 14)).toBeNull();
  });

  it("computes a positive ATR on a trending series", () => {
    const a = atr(trend(30), 14);
    expect(a).not.toBeNull();
    expect(a!).toBeGreaterThan(0);
  });

  it("computes a stop below the entry and inside safety bounds", () => {
    const bars = trend(30, 100, 1);
    const s = computeTrailingStop(bars, 100)!;
    expect(s.stop_price).toBeLessThan(bars[bars.length - 1].close);
    expect(s.stop_pct).toBeGreaterThanOrEqual(DEFAULT_TRAILING_STOP.min_stop_pct);
    expect(s.stop_pct).toBeLessThanOrEqual(DEFAULT_TRAILING_STOP.max_stop_pct);
  });

  it("stop ratchets up as price rises, never down", () => {
    const bars = trend(30, 100, 1);
    const s1 = computeTrailingStop(bars, 100)!;
    const nextClose = bars[bars.length - 1].close + 5;
    const nextBar: Bar = { high: nextClose + 1, low: nextClose - 1, close: nextClose };
    const s2 = advanceTrailingStop(s1, nextBar, bars[bars.length - 1].close);
    expect(s2.stop_price).toBeGreaterThanOrEqual(s1.stop_price);
    // Feed a lower bar — stop must NOT drop.
    const dipBar: Bar = { high: nextClose, low: nextClose - 10, close: nextClose - 5 };
    const s3 = advanceTrailingStop(s2, dipBar, nextClose);
    expect(s3.stop_price).toBeGreaterThanOrEqual(s2.stop_price);
  });

  it("triggers when close drops through the stop", () => {
    const bars = trend(30, 100, 1);
    const s1 = computeTrailingStop(bars, 100)!;
    const bust: Bar = { high: s1.stop_price - 1, low: s1.stop_price - 5, close: s1.stop_price - 2 };
    const s2 = advanceTrailingStop(s1, bust, bars[bars.length - 1].close);
    expect(s2.triggered).toBe(true);
  });

  it("widens the leash for a more volatile series", () => {
    const calm = computeTrailingStop(trend(30, 100, 1, 0.005), 100)!;
    const wild = computeTrailingStop(trend(30, 100, 1, 0.05), 100)!;
    expect(wild.stop_pct).toBeGreaterThan(calm.stop_pct);
  });
});
