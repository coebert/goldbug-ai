import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZING_LIMITS,
  applySizingLimits,
  resolveSizingLimits,
} from "@/lib/breakout-sizing-limits";

const sig = (symbol: string, date: string, size: number, barsHeld = 1) => ({
  symbol,
  date,
  size,
  barsHeld,
});

describe("resolveSizingLimits", () => {
  it("fills defaults and floors negatives", () => {
    expect(resolveSizingLimits()).toEqual(DEFAULT_SIZING_LIMITS);
    const l = resolveSizingLimits({ maxPositionSize: -2, maxConcurrentSignals: 2.7 });
    expect(l.maxPositionSize).toBe(0);
    expect(l.maxConcurrentSignals).toBe(2);
  });
});

describe("applySizingLimits", () => {
  it("caps any single position at maxPositionSize", () => {
    const { signals, report } = applySizingLimits([sig("A", "2026-01-01", 3)], {
      maxPositionSize: 1.2,
      maxTotalDeployedPct: 1000,
    });
    expect(signals[0].size).toBe(1.2);
    expect(signals[0].clamped).toContain("position");
    expect(report.breaches.position).toBe(1);
    expect(report.peakPositionSize).toBe(1.2);
  });

  it("skips signals that would exceed maxConcurrentSignals", () => {
    const overlapping = ["A", "B", "C"].map((s, i) =>
      sig(s, `2026-01-0${i + 1}`, 1, 10),
    );
    const { signals, report } = applySizingLimits(overlapping, {
      maxConcurrentSignals: 2,
      maxTotalDeployedPct: 1000,
    });
    expect(signals.map((s) => s.size)).toEqual([1, 1, 0]);
    expect(signals[2].clamped).toContain("concurrency");
    expect(report.peakConcurrent).toBe(2);
  });

  it("frees a slot once an earlier position's hold window closes", () => {
    const { signals } = applySizingLimits(
      [sig("A", "2026-01-01", 1, 1), sig("B", "2026-01-02", 1, 1)],
      { maxConcurrentSignals: 1, maxTotalDeployedPct: 1000 },
    );
    expect(signals.map((s) => s.size)).toEqual([1, 1]);
  });

  it("trims the aggregate budget, partially filling the boundary signal", () => {
    const trades = ["A", "B", "C", "D"].map((s, i) => sig(s, `2026-02-0${i + 1}`, 1));
    const { signals, report } = applySizingLimits(trades, {
      maxTotalDeployedPct: 50, // 4 signals × 0.5 = budget of 2 units
      maxConcurrentSignals: 10,
    });
    expect(signals.map((s) => s.size)).toEqual([1, 1, 0, 0]);
    expect(report.deployedPct).toBe(50);
    expect(report.requestedDeployedPct).toBe(100);
    expect(report.breaches.budget).toBeGreaterThan(0);
  });

  it("allows a partial fill when only part of the budget remains", () => {
    const { signals } = applySizingLimits(
      [sig("A", "2026-03-01", 1), sig("B", "2026-03-02", 1)],
      { maxTotalDeployedPct: 75, maxConcurrentSignals: 10 },
    );
    expect(signals[0].size).toBe(1);
    expect(signals[1].size).toBeCloseTo(0.5, 10);
  });

  it("never lets total deployment exceed the ceiling under any request", () => {
    const trades = Array.from({ length: 20 }, (_, i) =>
      sig(`S${i}`, `2026-04-${String(i + 1).padStart(2, "0")}`, 5, 3),
    );
    const { report } = applySizingLimits(trades, DEFAULT_SIZING_LIMITS);
    expect(report.deployedPct).toBeLessThanOrEqual(DEFAULT_SIZING_LIMITS.maxTotalDeployedPct);
    expect(report.peakPositionSize).toBeLessThanOrEqual(DEFAULT_SIZING_LIMITS.maxPositionSize);
    expect(report.peakConcurrent).toBeLessThanOrEqual(DEFAULT_SIZING_LIMITS.maxConcurrentSignals);
  });

  it("reports a clean pass when nothing breaches", () => {
    const { report } = applySizingLimits([sig("A", "2026-05-01", 1)], DEFAULT_SIZING_LIMITS);
    expect(report.breaches).toEqual({ position: 0, concurrency: 0, budget: 0 });
    expect(report.summary).toContain("Within safety limits");
  });

  it("handles an empty signal list", () => {
    const { signals, report } = applySizingLimits([]);
    expect(signals).toHaveLength(0);
    expect(report.deployedPct).toBe(0);
    expect(report.summary).toContain("No signals");
  });
});
