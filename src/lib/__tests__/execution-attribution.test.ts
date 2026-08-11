import { describe, it, expect } from "vitest";
import {
  EXECUTION_CHANNELS,
  channelSubsets,
  subsetKey,
  shapleyAttribution,
  type ExecutionChannel,
} from "../execution-attribution";

describe("channelSubsets / subsetKey", () => {
  it("enumerates the full lattice once, baseline first and full set last", () => {
    const subsets = channelSubsets();
    expect(subsets).toHaveLength(2 ** EXECUTION_CHANNELS.length);
    expect(subsets[0]).toEqual([]);
    expect(subsets.at(-1)).toEqual([...EXECUTION_CHANNELS]);
    expect(new Set(subsets.map((s) => subsetKey(s))).size).toBe(subsets.length);
  });

  it("keys are canonical regardless of input order or duplicates", () => {
    expect(subsetKey(["stress", "slippage"])).toBe("slippage+stress");
    expect(subsetKey(["slippage", "stress", "slippage"])).toBe("slippage+stress");
    expect(subsetKey([])).toBe("");
  });
});

describe("shapleyAttribution", () => {
  // Additive world: each channel costs a fixed amount, no interaction.
  const additive: Record<ExecutionChannel, number> = { slippage: -3, fillRate: -2, stress: 0 };
  const additiveValue = (s: readonly ExecutionChannel[]) =>
    10 + s.reduce((a, c) => a + additive[c], 0);

  it("recovers the exact per-channel cost when effects are additive", () => {
    const a = shapleyAttribution(additiveValue);
    expect(a.baseline).toBe(10);
    expect(a.full).toBe(5);
    expect(a.total).toBe(-5);
    const by = Object.fromEntries(a.contributions.map((c) => [c.channel, c.shapley]));
    expect(by["slippage"]).toBeCloseTo(-3, 9);
    expect(by["fillRate"]).toBeCloseTo(-2, 9);
    expect(by["stress"]).toBeCloseTo(0, 9);
    expect(a.interaction).toBeCloseTo(0, 9);
  });

  // Realistic world: stress does nothing alone, it multiplies the others.
  const amplifying = (s: readonly ExecutionChannel[]) => {
    const on = new Set(s);
    const base = (on.has("slippage") ? 3 : 0) + (on.has("fillRate") ? 2 : 0);
    return 10 - base * (on.has("stress") ? 2 : 1);
  };

  it("gives an amplifier real credit even though its solo effect is zero", () => {
    const a = shapleyAttribution(amplifying);
    const stress = a.contributions.find((c) => c.channel === "stress")!;
    expect(stress.solo).toBe(0);
    expect(stress.shapley).toBeLessThan(0);
    // Removing stress last recovers half the damage.
    expect(stress.marginal).toBeCloseTo(-5, 9);
  });

  it("splits exactly: contributions always sum back to the total", () => {
    for (const valueOf of [additiveValue, amplifying]) {
      const a = shapleyAttribution(valueOf);
      const sum = a.contributions.reduce((x, c) => x + c.shapley, 0);
      expect(sum).toBeCloseTo(a.total, 9);
      expect(a.contributions.reduce((x, c) => x + c.share, 0)).toBeCloseTo(1, 9);
    }
  });

  it("reports interaction as the gap between the total and the solo effects", () => {
    const a = shapleyAttribution(amplifying);
    const soloSum = a.contributions.reduce((x, c) => x + c.solo, 0);
    expect(a.interaction).toBeCloseTo(a.total - soloSum, 9);
    // Compounding damage: the joint tail is worse than the parts summed.
    expect(a.interaction).toBeLessThan(0);
  });

  it("is order independent — permuting the channel list does not move a share", () => {
    const a = shapleyAttribution(amplifying, ["slippage", "fillRate", "stress"]);
    const b = shapleyAttribution(amplifying, ["stress", "fillRate", "slippage"]);
    for (const c of a.contributions) {
      const other = b.contributions.find((x) => x.channel === c.channel)!;
      expect(other.shapley).toBeCloseTo(c.shapley, 9);
    }
  });

  it("evaluates each subset exactly once and passes matching subset/key pairs", () => {
    const seen: string[] = [];
    shapleyAttribution((subset, key) => {
      expect(key).toBe(subsetKey(subset));
      seen.push(key);
      return subset.length;
    });
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  it("handles a zero total without dividing by zero", () => {
    const a = shapleyAttribution(() => 7);
    expect(a.total).toBe(0);
    for (const c of a.contributions) expect(c.share).toBe(0);
  });
});
