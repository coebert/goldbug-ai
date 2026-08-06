// Contract for the shared sparkline scaling used by every holding-trend chart.
//
// The point of a single domain helper is that the axis labels a card prints
// and the line the SVG draws come from the same numbers. These tests lock the
// properties the axis frame relies on: padding, nice bounds, flat-series
// handling, and never inventing negative prices.

import { describe, expect, it } from "vitest";
import { sparklineDomain } from "@/lib/sparkline-scale";

describe("sparklineDomain", () => {
  it("brackets the data with padding on both sides", () => {
    const d = sparklineDomain([990, 1000, 1040]);
    expect(d.min).toBeLessThan(990);
    expect(d.max).toBeGreaterThan(1040);
  });

  it("returns min/mid/max ticks in ascending order", () => {
    const d = sparklineDomain([4.02, 4.05, 4.11]);
    expect(d.ticks[0]).toBe(d.min);
    expect(d.ticks[2]).toBe(d.max);
    expect(d.ticks[1]).toBeCloseTo((d.min + d.max) / 2, 10);
    expect(d.ticks[0]).toBeLessThan(d.ticks[1]);
    expect(d.ticks[1]).toBeLessThan(d.ticks[2]);
  });

  it("opens a band around a perfectly flat series", () => {
    const d = sparklineDomain([107.32, 107.32, 107.32]);
    expect(d.max).toBeGreaterThan(d.min);
    expect(107.32).toBeGreaterThan(d.min);
    expect(107.32).toBeLessThan(d.max);
  });

  it("never produces a negative floor for a non-negative series", () => {
    expect(sparklineDomain([0.4, 1.2, 0.9]).min).toBeGreaterThanOrEqual(0);
    expect(sparklineDomain([0, 0.2]).min).toBeGreaterThanOrEqual(0);
  });

  it("allows a negative floor when the data really goes negative", () => {
    expect(sparklineDomain([-12, 4]).min).toBeLessThan(0);
  });

  it("is stable — identical input gives identical geometry", () => {
    const a = sparklineDomain([1, 2, 3]);
    const b = sparklineDomain([1, 2, 3]);
    expect(a).toEqual(b);
  });

  it("ignores non-finite values instead of collapsing the axis", () => {
    const d = sparklineDomain([10, Number.NaN, 20, Number.POSITIVE_INFINITY]);
    expect(Number.isFinite(d.min)).toBe(true);
    expect(Number.isFinite(d.max)).toBe(true);
    expect(d.max).toBeGreaterThan(20);
  });

  it("degrades to a unit box when there is nothing to plot", () => {
    expect(sparklineDomain([])).toEqual({ min: 0, max: 1, ticks: [0, 0.5, 1] });
  });

  it("scales two series with the same shape the same way", () => {
    // Same relative movement at different magnitudes must give the same
    // normalised position for the mid point, so cards stay comparable.
    const pos = (vals: number[], v: number) => {
      const d = sparklineDomain(vals);
      return (v - d.min) / (d.max - d.min);
    };
    expect(pos([100, 110, 120], 110)).toBeCloseTo(pos([1000, 1100, 1200], 1100), 6);
  });
});
