import { describe, it, expect } from "vitest";
import { unifiedScore, SCORER_WEIGHTS } from "../unified-score";

describe("unifiedScore", () => {
  it("declares weights that sum to 1", () => {
    const sum = Object.values(SCORER_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it("leaves size alone when the scorers agree with the side", () => {
    const r = unifiedScore({
      side: "buy",
      alphaComposite: 0.6,
      rankPercentile: 0.95,
      ensembleScore: 0.5,
    });
    expect(r.score).toBeGreaterThan(0.5);
    expect(r.mult).toBe(1);
    expect(r.note).toBeNull();
  });

  it("shrinks once — not three times — when all scorers oppose", () => {
    const r = unifiedScore({
      side: "buy",
      alphaComposite: -0.9,
      rankPercentile: 0.02,
      ensembleScore: -0.8,
    });
    // A single coordinated haircut, floored well above the old 0.5^3 = 0.125.
    expect(r.mult).toBeGreaterThanOrEqual(0.45);
    expect(r.mult).toBeLessThan(0.6);
    expect(r.note).toContain("systematic≠buy");
  });

  it("treats a mid-pack name as neutral rather than a headwind", () => {
    const r = unifiedScore({
      side: "buy",
      alphaComposite: 0,
      rankPercentile: 0.5,
      ensembleScore: 0,
    });
    expect(r.score).toBeCloseTo(0, 9);
    expect(r.mult).toBe(1);
  });

  it("renormalises when a scorer is unavailable", () => {
    const both = unifiedScore({ side: "buy", alphaComposite: -0.8, rankPercentile: null, ensembleScore: -0.8 });
    const all = unifiedScore({ side: "buy", alphaComposite: -0.8, rankPercentile: 0.1, ensembleScore: -0.8 });
    expect(both.used).toEqual(["alpha", "ensemble"]);
    expect(both.score).toBeCloseTo(-0.8, 6);
    expect(all.used).toHaveLength(3);
  });

  it("is neutral with no inputs at all", () => {
    const r = unifiedScore({ side: "sell", alphaComposite: null, rankPercentile: null, ensembleScore: null });
    expect(r).toMatchObject({ score: 0, mult: 1, used: [] });
  });

  it("flips sign correctly for sells", () => {
    const bearish = { alphaComposite: -0.7, rankPercentile: 0.05, ensembleScore: -0.6 };
    expect(unifiedScore({ side: "sell", ...bearish }).mult).toBe(1);
    expect(unifiedScore({ side: "buy", ...bearish }).mult).toBeLessThan(1);
  });

  it("scales the haircut with the strength of disagreement", () => {
    const mild = unifiedScore({ side: "buy", alphaComposite: -0.3, rankPercentile: 0.4, ensembleScore: -0.2 });
    const severe = unifiedScore({ side: "buy", alphaComposite: -1, rankPercentile: 0, ensembleScore: -1 });
    expect(mild.mult).toBeGreaterThan(severe.mult);
    expect(severe.mult).toBeCloseTo(0.45, 6);
  });
});
