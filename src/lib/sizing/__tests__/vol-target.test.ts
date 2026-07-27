import { describe, it, expect } from "vitest";
import { volTargetSize } from "@/lib/sizing/vol-target";

describe("volTargetSize", () => {
  it("shrinks size as realized vol rises (monotone)", () => {
    const base = { baseFraction: 0.1, targetVol: 0.15, maxFraction: 0.2 };
    const a = volTargetSize({ ...base, realizedVol: 0.10 }).fraction;
    const b = volTargetSize({ ...base, realizedVol: 0.20 }).fraction;
    const c = volTargetSize({ ...base, realizedVol: 0.40 }).fraction;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("never exceeds the max fraction cap", () => {
    for (const rv of [0.001, 0.01, 0.05, 0.1, 0.5, 1.0]) {
      const r = volTargetSize({ baseFraction: 0.1, targetVol: 0.3, maxFraction: 0.15, realizedVol: rv });
      expect(r.fraction).toBeLessThanOrEqual(0.15 + 1e-9);
      expect(r.fraction).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses the floor when realized vol is degenerate", () => {
    const r = volTargetSize({ baseFraction: 0.1, targetVol: 0.15, maxFraction: 0.2, realizedVol: 0 });
    expect(r.fraction).toBeGreaterThan(0);
    expect(Number.isFinite(r.fraction)).toBe(true);
  });
});
