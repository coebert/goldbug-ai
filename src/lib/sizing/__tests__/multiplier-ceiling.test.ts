import { describe, expect, it } from "vitest";
import { combineBoosts, BOOST_CEILING } from "../multiplier-ceiling";

describe("combined multiplier ceiling", () => {
  it("is a no-op with no boosts", () => {
    const r = combineBoosts([null, undefined, { label: "x", mult: 1 }, { label: "y", mult: 0.5 }]);
    expect(r.mult).toBe(1);
    expect(r.note).toBeNull();
    expect(r.binding).toBeNull();
  });

  it("multiplies boosts under the ceiling", () => {
    const r = combineBoosts([{ label: "a", mult: 1.2 }, { label: "b", mult: 1.1 }]);
    expect(r.mult).toBeCloseTo(1.32, 9);
    expect(r.capped).toBe(false);
    expect(r.binding).toBe("a");
  });

  it("caps a runaway stack and names the ceiling", () => {
    const r = combineBoosts([
      { label: "alpha", mult: 1.5 },
      { label: "sector", mult: 1.4 },
      { label: "breakout", mult: 1.3 },
    ]);
    expect(r.rawProduct).toBeCloseTo(2.73, 9);
    expect(r.mult).toBe(BOOST_CEILING);
    expect(r.capped).toBe(true);
    expect(r.binding).toBe("ceiling");
    expect(r.note).toContain("capped from");
  });

  it("honours a custom ceiling and never returns below 1", () => {
    const r = combineBoosts([{ label: "a", mult: 1.9 }], { ceiling: 1.25 });
    expect(r.mult).toBe(1.25);
    const floorCheck = combineBoosts([{ label: "a", mult: 1.05 }], { ceiling: 0.5 });
    expect(floorCheck.mult).toBeGreaterThanOrEqual(1);
  });

  it("ignores non-finite multipliers", () => {
    const r = combineBoosts([{ label: "nan", mult: Number.NaN }, { label: "ok", mult: 1.2 }]);
    expect(r.mult).toBeCloseTo(1.2, 9);
    expect(r.applied).toHaveLength(1);
  });
});
