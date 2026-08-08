import { describe, expect, it } from "vitest";
import { estimateHoldingPeriod } from "../expected-holding-period";

const w = (o: Record<string, number>) => o as never;

describe("estimateHoldingPeriod", () => {
  it("returns no window for sells", () => {
    const r = estimateHoldingPeriod({ side: "sell" });
    expect(r.applicable).toBe(false);
    expect(r.label).toMatch(/closing/);
  });

  it("gives a multi-week window for trend-led buys", () => {
    const r = estimateHoldingPeriod({ side: "buy", weights: w({ sma_trend: 0.7, rsi: 0.1 }) });
    expect(r.minDays).toBe(30);
    expect(r.maxDays).toBe(90);
    expect(r.label).toMatch(/months|weeks/);
  });

  it("shortens for momentum snap-backs", () => {
    const r = estimateHoldingPeriod({ side: "buy", weights: w({ rsi: 0.8, sma_trend: 0.1 }) });
    expect(r.maxDays).toBeLessThanOrEqual(15);
  });

  it("shortens further for mania-driven reasons", () => {
    const r = estimateHoldingPeriod({
      side: "buy",
      weights: w({ sma_trend: 0.9 }),
      reason: "retail mania squeeze detected",
    });
    expect(r.maxDays).toBeLessThanOrEqual(10);
  });

  it("caps holds in swing style", () => {
    const r = estimateHoldingPeriod({
      side: "buy",
      weights: w({ sma_trend: 0.9 }),
      tradingStyle: "swing",
    });
    expect(r.maxDays).toBeLessThanOrEqual(20);
    expect(r.basis).toMatch(/swing/);
  });

  it("respects a minimum hold floor", () => {
    const r = estimateHoldingPeriod({
      side: "buy",
      weights: w({ rsi: 1 }),
      minHoldDays: 12,
    });
    expect(r.minDays).toBeGreaterThanOrEqual(12);
    expect(r.maxDays).toBeGreaterThanOrEqual(r.minDays);
  });

  it("falls back to a balanced window with no weights", () => {
    const r = estimateHoldingPeriod({ side: "buy" });
    expect(r.applicable).toBe(true);
    expect(r.minDays).toBe(20);
    expect(r.earlyExit).toMatch(/stop-loss/);
  });
});
