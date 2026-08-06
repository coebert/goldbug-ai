import { describe, it, expect } from "vitest";
import { combineHaircuts, HAIRCUT_FLOOR } from "../sizing-haircuts";

describe("combineHaircuts", () => {
  it("is a no-op when nothing shrinks the trade", () => {
    const r = combineHaircuts([{ label: "calib", mult: 1 }, null, { label: "dd", mult: 1.2 }]);
    expect(r.mult).toBe(1);
    expect(r.note).toBeNull();
    expect(r.applied).toEqual([]);
  });

  it("honours a single haircut in full", () => {
    const r = combineHaircuts([{ label: "cooldown", mult: 0.5 }]);
    expect(r.mult).toBeCloseTo(0.5, 6);
    expect(r.rawProduct).toBeCloseTo(0.5, 6);
  });

  it("damps the second and later haircuts instead of compounding them", () => {
    const three = combineHaircuts([
      { label: "a", mult: 0.5 },
      { label: "b", mult: 0.5 },
      { label: "c", mult: 0.5 },
    ]);
    // Sequential multiplication would leave 12.5% of the ticket; damping
    // plus the floor keeps three mild headwinds at 35%.
    expect(three.rawProduct).toBeCloseTo(0.125, 6);
    expect(three.mult).toBeGreaterThanOrEqual(HAIRCUT_FLOOR);
    expect(three.mult).toBeLessThan(0.5);
    expect(three.mult / three.rawProduct).toBeGreaterThan(2);

    const two = combineHaircuts([
      { label: "a", mult: 0.8 },
      { label: "b", mult: 0.8 },
    ]);
    expect(two.mult).toBeCloseTo(0.8 * (1 - 0.2 * 0.65), 6);
    expect(two.mult).toBeGreaterThan(two.rawProduct);
  });

  it("never takes a ticket below the floor", () => {
    const r = combineHaircuts([
      { label: "a", mult: 0.3 },
      { label: "b", mult: 0.3 },
      { label: "c", mult: 0.3 },
      { label: "d", mult: 0.3 },
    ]);
    expect(r.mult).toBe(HAIRCUT_FLOOR);
    expect(r.floored).toBe(true);
  });

  it("applies the most severe haircut first so ordering is irrelevant", () => {
    const a = combineHaircuts([
      { label: "x", mult: 0.9 },
      { label: "y", mult: 0.5 },
    ]);
    const b = combineHaircuts([
      { label: "y", mult: 0.5 },
      { label: "x", mult: 0.9 },
    ]);
    expect(a.mult).toBeCloseTo(b.mult, 12);
    expect(a.applied[0]?.label).toBe("y");
  });

  it("is never more generous than no haircut and never harsher than the product", () => {
    const r = combineHaircuts([
      { label: "a", mult: 0.8 },
      { label: "b", mult: 0.7 },
      { label: "c", mult: 0.95 },
    ]);
    expect(r.mult).toBeLessThanOrEqual(1);
    expect(r.mult).toBeGreaterThanOrEqual(r.rawProduct);
  });

  it("respects an explicit floor override", () => {
    const r = combineHaircuts(
      [{ label: "a", mult: 0.1 }, { label: "b", mult: 0.1 }],
      { floor: 0.05 },
    );
    expect(r.mult).toBeGreaterThanOrEqual(0.05);
    expect(r.mult).toBeLessThan(0.35);
  });
});
