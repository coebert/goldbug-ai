import { describe, it, expect } from "vitest";
import { desiredWeight, targetWeightSpend } from "../target-weight";

describe("desiredWeight", () => {
  it("stays at baseline with no alpha/conviction", () => {
    expect(desiredWeight({ baseWeight: 0.05, maxWeight: 0.15 })).toBeCloseTo(0.05, 6);
  });

  it("lifts toward, but never past, the cap", () => {
    const w = desiredWeight({ baseWeight: 0.05, maxWeight: 0.15, alphaMag: 1, conviction: 1 });
    expect(w).toBeCloseTo(0.15, 6);
    const mid = desiredWeight({ baseWeight: 0.05, maxWeight: 0.15, alphaMag: 0.5, conviction: 0.5 });
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.15);
  });

  it("clamps vol scaling and never exceeds the cap", () => {
    const w = desiredWeight({ baseWeight: 0.14, maxWeight: 0.15, alphaMag: 1, conviction: 1, volScale: 99 });
    expect(w).toBeLessThanOrEqual(0.15);
  });
});

describe("targetWeightSpend", () => {
  const nav = 10_000;

  it("buys only the gap to target", () => {
    const r = targetWeightSpend({ nav, currentValue: 500, targetWeight: 0.1, minTicketBase: 250 });
    expect(r.reason).toBe("ok");
    expect(r.spend).toBeCloseTo(500, 6);
  });

  it("refuses to nibble when the gap is below the min ticket", () => {
    const r = targetWeightSpend({ nav, currentValue: 900, targetWeight: 0.1, minTicketBase: 250 });
    expect(r.reason).toBe("gap_below_min_ticket");
    expect(r.spend).toBe(0);
  });

  it("returns zero at or above target", () => {
    expect(targetWeightSpend({ nav, currentValue: 1000, targetWeight: 0.1 }).reason).toBe("at_target");
    expect(targetWeightSpend({ nav, currentValue: 1600, targetWeight: 0.1 }).reason).toBe("over_target");
  });

  it("never accumulates past the target across repeated buys", () => {
    let held = 0;
    for (let i = 0; i < 20; i++) {
      const r = targetWeightSpend({ nav, currentValue: held, targetWeight: 0.15, minTicketBase: 250 });
      if (r.reason !== "ok") break;
      held += Math.min(r.spend, 400); // partial fills, worst case for drift
    }
    expect(held).toBeLessThanOrEqual(0.15 * nav + 1e-9);
  });

  it("handles missing NAV", () => {
    expect(targetWeightSpend({ nav: 0, currentValue: 0, targetWeight: 0.1 }).reason).toBe("no_nav");
  });
});
