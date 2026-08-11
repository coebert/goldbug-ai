import { describe, expect, it } from "vitest";
import { unifiedVolSize } from "../unified-vol-size";
import { volTargetSize } from "../vol-target";
import { riskParityTargetSpend } from "@/lib/alpha/sizing";

describe("unified vol sizing", () => {
  it("sizes the position to the vol budget", () => {
    const r = unifiedVolSize({ totalValue: 10_000, vol: 0.02, targetVolPct: 0.015 });
    // 0.015 * 10000 / 0.02 = 7500, but the 20% NAV cap binds first.
    expect(r.targetValue).toBe(2_000);
    expect(r.binding).toBe("nav-cap");
  });

  it("is monotone decreasing in volatility", () => {
    const calm = unifiedVolSize({ totalValue: 10_000, vol: 0.05, targetVolPct: 0.005, navCap: 1 });
    const wild = unifiedVolSize({ totalValue: 10_000, vol: 0.2, targetVolPct: 0.005, navCap: 1 });
    expect(calm.targetValue).toBeGreaterThan(wild.targetValue);
    expect(calm.binding).toBe("vol");
  });

  it("subtracts the existing position from the room to buy", () => {
    const r = unifiedVolSize({
      totalValue: 10_000, vol: 0.1, targetVolPct: 0.01, navCap: 1, existingValue: 600,
    });
    expect(r.targetValue).toBe(1_000);
    expect(r.room).toBe(400);
  });

  it("never returns negative room when already over target", () => {
    const r = unifiedVolSize({
      totalValue: 10_000, vol: 0.1, targetVolPct: 0.01, navCap: 1, existingValue: 5_000,
    });
    expect(r.room).toBe(0);
  });

  it("tilts the budget by alpha only under risk parity", () => {
    const base = { totalValue: 10_000, vol: 0.1, targetVolPct: 0.01, navCap: 1 } as const;
    const flat = unifiedVolSize({ ...base, alphaMag: 1 });
    const tilted = unifiedVolSize({ ...base, riskParity: true, alphaMag: 1 });
    const weak = unifiedVolSize({ ...base, riskParity: true, alphaMag: 0 });
    expect(flat.tilt).toBe(1);
    expect(tilted.targetValue).toBeCloseTo(1_500, 6);
    expect(weak.targetValue).toBeCloseTo(500, 6);
  });

  it("falls back to the NAV cap with no vol estimate", () => {
    const r = unifiedVolSize({ totalValue: 10_000, vol: null, targetVolPct: 0.01, navCap: 0.1 });
    expect(r.binding).toBe("no-vol-data");
    expect(r.targetValue).toBe(1_000);
  });

  it("clamps the NAV cap into a sane range", () => {
    const r = unifiedVolSize({ totalValue: 10_000, vol: 0.001, targetVolPct: 0.01, navCap: 5 });
    expect(r.targetValue).toBeLessThanOrEqual(10_000);
  });

  it("keeps riskParityTargetSpend behaviour after delegating", () => {
    expect(riskParityTargetSpend({ alphaMag: 0.5, vol: 0, totalValue: 10_000, targetVolPct: 0.01 })).toBe(0);
    const spend = riskParityTargetSpend({
      alphaMag: 1, vol: 0.1, totalValue: 10_000, targetVolPct: 0.01, navCap: 1,
    });
    expect(spend).toBeCloseTo(1_500, 6);
  });

  it("keeps volTargetSize behaviour after delegating", () => {
    const r = volTargetSize({ baseFraction: 0.1, targetVol: 0.15, realizedVol: 0.3, maxFraction: 0.2 });
    expect(r.fraction).toBeCloseTo(0.05, 9);
    expect(r.scale).toBeCloseTo(0.5, 9);
    const capped = volTargetSize({ baseFraction: 0.1, targetVol: 0.6, realizedVol: 0.1, maxFraction: 0.2 });
    expect(capped.fraction).toBeCloseTo(0.2, 9);
  });
});
