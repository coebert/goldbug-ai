import { describe, it, expect } from "vitest";
import { alphaConvictionBonus, riskParityTargetSpend } from "../sizing";

describe("alphaConvictionBonus", () => {
  it("returns 1 when disabled", () => {
    expect(alphaConvictionBonus({ side: "buy", alphaComposite: 0.9, conviction: 0.9, enabled: false }).mult).toBe(1);
  });

  it("returns 1 when alpha disagrees with side", () => {
    expect(alphaConvictionBonus({ side: "buy", alphaComposite: -0.8, conviction: 0.9 }).mult).toBe(1);
    expect(alphaConvictionBonus({ side: "sell", alphaComposite: 0.8, conviction: 0.9 }).mult).toBe(1);
  });

  it("returns 1 when conviction or alpha is weak", () => {
    expect(alphaConvictionBonus({ side: "buy", alphaComposite: 0.2, conviction: 0.95 }).mult).toBe(1);
    expect(alphaConvictionBonus({ side: "buy", alphaComposite: 0.9, conviction: 0.4 }).mult).toBe(1);
  });

  it("lifts spend when both signals are strong and aligned, capped", () => {
    const r = alphaConvictionBonus({ side: "buy", alphaComposite: 1, conviction: 1, cap: 1.5 });
    expect(r.mult).toBeCloseTo(1.5, 5);
    expect(r.note).toContain("alpha×conv");
  });

  it("never shrinks spend below 1x", () => {
    for (const a of [-1, -0.5, 0, 0.1, 0.3, 0.7, 1]) {
      for (const c of [0, 0.3, 0.6, 0.9, 1]) {
        const r = alphaConvictionBonus({ side: "buy", alphaComposite: a, conviction: c });
        expect(r.mult).toBeGreaterThanOrEqual(1);
        expect(r.mult).toBeLessThanOrEqual(1.5);
      }
    }
  });
});

describe("riskParityTargetSpend", () => {
  it("returns 0 with no vol", () => {
    expect(riskParityTargetSpend({ alphaMag: 1, vol: 0, totalValue: 10_000, targetVolPct: 0.015 })).toBe(0);
    expect(riskParityTargetSpend({ alphaMag: 1, vol: null, totalValue: 10_000, targetVolPct: 0.015 })).toBe(0);
  });

  it("scales target by alpha magnitude", () => {
    const weak = riskParityTargetSpend({ alphaMag: 0, vol: 0.02, totalValue: 10_000, targetVolPct: 0.015 });
    const strong = riskParityTargetSpend({ alphaMag: 1, vol: 0.02, totalValue: 10_000, targetVolPct: 0.015 });
    expect(strong).toBeGreaterThan(weak);
    // strong is 3x weak (scale 1.5 vs 0.5) unless nav-capped
    expect(strong / weak).toBeCloseTo(3, 5);
  });

  it("respects NAV cap", () => {
    const t = riskParityTargetSpend({ alphaMag: 1, vol: 0.001, totalValue: 10_000, targetVolPct: 0.05, navCap: 0.2 });
    expect(t).toBeLessThanOrEqual(2_000 + 1e-6);
  });
});
