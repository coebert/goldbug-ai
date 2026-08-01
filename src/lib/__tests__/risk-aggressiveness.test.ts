import { describe, it, expect } from "vitest";
import {
  resolveAggressiveness,
  aggressiveBuySpend,
  aggressiveSellQty,
  clampDialLevel,
  AGGRESSIVENESS_BOUNDS,
  SIZE_MULT_BOUNDS,
} from "../risk-aggressiveness";
import { RISK_LEVELS, riskPresetConfig } from "../risk-presets";

describe("risk dial → aggressiveness", () => {
  it("is monotonic in size and buy aggressiveness across levels", () => {
    const legs = RISK_LEVELS.map((l) => resolveAggressiveness(riskPresetConfig(l)));
    for (let i = 1; i < legs.length; i++) {
      expect(legs[i].sizeMult).toBeGreaterThan(legs[i - 1].sizeMult);
      expect(legs[i].buy).toBeGreaterThan(legs[i - 1].buy);
      // Defensive dials exit faster than aggressive ones.
      expect(legs[i].sell).toBeLessThan(legs[i - 1].sell);
      // Aggressive dials tolerate less drift before rebalancing.
      expect(legs[i].driftBand).toBeLessThan(legs[i - 1].driftBand);
    }
  });

  it("defaults to balanced for missing or junk configs", () => {
    for (const bad of [null, undefined, {}, 42, "x", { risk_level: "nope" }]) {
      const a = resolveAggressiveness(bad);
      expect(a.level).toBe(3);
      expect(a.sizeMult).toBe(1);
      expect(a.buy).toBe(0.8);
      expect(a.sell).toBe(1);
    }
  });

  it("clamps out-of-range stored values to hard bounds", () => {
    const hot = resolveAggressiveness({
      risk_level: 5,
      size_multiplier: 99,
      buy_aggressiveness: 99,
      sell_aggressiveness: -3,
    });
    expect(hot.sizeMult).toBe(SIZE_MULT_BOUNDS.max);
    expect(hot.buy).toBe(AGGRESSIVENESS_BOUNDS.max);
    expect(hot.sell).toBe(AGGRESSIVENESS_BOUNDS.min);
  });

  it("clamps the dial level itself", () => {
    expect(clampDialLevel(0)).toBe(1);
    expect(clampDialLevel(9)).toBe(5);
    expect(clampDialLevel(3.4)).toBe(3);
    expect(clampDialLevel(NaN)).toBe(3);
  });

  it("overrides win over the preset", () => {
    const a = resolveAggressiveness({ risk_level: 1, buy_aggressiveness: 1.2 });
    expect(a.level).toBe(1);
    expect(a.buy).toBe(1.2);
    expect(a.sizeMult).toBe(0.5); // preset still supplies the rest
  });
});

describe("sizing helpers", () => {
  const low = resolveAggressiveness(riskPresetConfig(1));
  const high = resolveAggressiveness(riskPresetConfig(5));

  it("scales buy spend by size × buy aggressiveness", () => {
    expect(aggressiveBuySpend(1000, low)).toBeCloseTo(1000 * 0.5 * 0.4, 6);
    expect(aggressiveBuySpend(1000, high)).toBeGreaterThan(aggressiveBuySpend(1000, low));
  });

  it("never returns a negative or non-finite buy spend", () => {
    for (const v of [0, -100, NaN, Infinity]) {
      expect(aggressiveBuySpend(v as number, high)).toBe(0);
    }
  });

  it("never sells more than is held, even when accelerating exits", () => {
    // low.sell = 1.2 would overshoot without the clamp
    expect(aggressiveSellQty(100, 100, low)).toBe(100);
    expect(aggressiveSellQty(50, 100, low)).toBeCloseTo(60, 6);
    expect(aggressiveSellQty(50, 100, high)).toBeCloseTo(40, 6);
  });

  it("returns zero for empty or invalid sells", () => {
    expect(aggressiveSellQty(0, 100, high)).toBe(0);
    expect(aggressiveSellQty(NaN, 100, high)).toBe(0);
    expect(aggressiveSellQty(10, 0, high)).toBe(0);
  });
});
