import { describe, it, expect } from "vitest";
import {
  vwapWeights,
  twapWeights,
  chooseSliceCount,
  buildSliceSchedule,
  spreadAwareLimit,
} from "../execution-vwap";

describe("vwapWeights", () => {
  it("sums to 1 for any bucket count", () => {
    for (const n of [2, 3, 4, 6, 8, 12]) {
      const s = vwapWeights(n).reduce((a, b) => a + b, 0);
      expect(s).toBeCloseTo(1, 6);
    }
  });
  it("has heavier open and close buckets than midday", () => {
    const w = vwapWeights(6);
    expect(w[0]).toBeGreaterThan(w[3]); // open > midday
    expect(w[w.length - 1]).toBeGreaterThan(w[3]); // close > midday
  });
});

describe("twapWeights", () => {
  it("is uniform and sums to 1", () => {
    const w = twapWeights(5);
    expect(w.every((x) => Math.abs(x - 0.2) < 1e-9)).toBe(true);
  });
});

describe("chooseSliceCount", () => {
  it("returns 1 for tiny orders relative to ADV", () => {
    expect(chooseSliceCount(1_000, 10_000_000)).toBe(1);
  });
  it("returns floor when ADV unknown", () => {
    expect(chooseSliceCount(50_000, null)).toBe(2);
  });
  it("scales with participation, capped at max", () => {
    // Order = 100% of ADV → needs many slices, hit max=8
    expect(chooseSliceCount(2_000_000, 1_000_000)).toBe(8);
  });
  it("chooses a middling count for medium orders (~30% ADV)", () => {
    const n = chooseSliceCount(300_000, 1_000_000);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(8);
  });
});

describe("buildSliceSchedule", () => {
  it("returns a single bucket for immediate strategy", () => {
    const s = buildSliceSchedule({ strategy: "immediate", totalQty: 100, nSlices: 4, windowMinutes: 60 });
    expect(s).toHaveLength(1);
    expect(s[0].qty).toBe(100);
    expect(s[0].offset_min).toBe(0);
  });
  it("VWAP schedule qty sums to totalQty (within lot)", () => {
    const s = buildSliceSchedule({ strategy: "vwap", totalQty: 1000, nSlices: 6, windowMinutes: 90 });
    const sum = s.reduce((a, b) => a + b.qty, 0);
    expect(Math.abs(sum - 1000)).toBeLessThan(0.001);
  });
  it("TWAP produces roughly equal buckets", () => {
    const s = buildSliceSchedule({ strategy: "twap", totalQty: 400, nSlices: 4, windowMinutes: 60 });
    for (const b of s) expect(b.qty).toBeCloseTo(100, 3);
  });
  it("offsets are non-decreasing and inside the window", () => {
    const s = buildSliceSchedule({ strategy: "vwap", totalQty: 100, nSlices: 5, windowMinutes: 100 });
    for (let i = 1; i < s.length; i++) expect(s[i].offset_min).toBeGreaterThanOrEqual(s[i - 1].offset_min);
    expect(s[s.length - 1].offset_min).toBeLessThanOrEqual(100);
  });
  it("VWAP first/last buckets are larger than middle", () => {
    const s = buildSliceSchedule({ strategy: "vwap", totalQty: 1000, nSlices: 6, windowMinutes: 90 });
    const middle = s[Math.floor(s.length / 2)].qty;
    expect(s[0].qty).toBeGreaterThan(middle);
    expect(s[s.length - 1].qty).toBeGreaterThan(middle);
  });
});

describe("spreadAwareLimit", () => {
  it("buys above mid, sells below mid", () => {
    const buy = spreadAwareLimit({ midPrice: 100, spreadBps: 20, side: "buy", aggressiveness: 1 });
    const sell = spreadAwareLimit({ midPrice: 100, spreadBps: 20, side: "sell", aggressiveness: 1 });
    expect(buy).toBeGreaterThan(100);
    expect(sell).toBeLessThan(100);
  });
  it("at aggressiveness=0 stays at mid", () => {
    expect(spreadAwareLimit({ midPrice: 50, spreadBps: 40, side: "buy", aggressiveness: 0 })).toBe(50);
  });
  it("caps aggressiveness at 1 and full spread", () => {
    // 100 spread bps → half = 50 bps = 0.005 → edge at aggr=1 is 100 * 0.005 = 0.5
    const buy = spreadAwareLimit({ midPrice: 100, spreadBps: 100, side: "buy", aggressiveness: 2 });
    expect(buy).toBeCloseTo(100.5, 6);
  });
});
