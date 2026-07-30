import { describe, expect, it } from "vitest";
import { addDeltas, deltaDomainFor } from "../equity-pct-chart";

describe("addDeltas", () => {
  const rows = [
    { at: "2026-07-24T10:00:00Z", value: 10000, pct: 0 },
    { at: "2026-07-24T11:00:00Z", value: 10100, pct: 1 },
    { at: "2026-07-24T12:00:00Z", value: 9900, pct: -1 },
  ];

  it("leaves the first point at zero delta", () => {
    expect(addDeltas(rows)[0]).toMatchObject({ deltaPct: 0, deltaValue: 0 });
  });

  it("computes percentage-point and money deltas", () => {
    const out = addDeltas(rows);
    expect(out[1].deltaPct).toBeCloseTo(1);
    expect(out[1].deltaValue).toBeCloseTo(100);
    expect(out[2].deltaPct).toBeCloseTo(-2);
    expect(out[2].deltaValue).toBeCloseTo(-200);
  });

  it("nets deposits landing between two points out of the money delta", () => {
    const daily = [
      { at: "2026-07-24", value: 10000, pct: 0 },
      { at: "2026-07-25", value: 10500, pct: 0.5 },
    ];
    const out = addDeltas(daily, [{ date: "2026-07-25", amount: 400 }]);
    expect(out[1].deltaValue).toBeCloseTo(100);
  });
});

describe("deltaDomainFor", () => {
  it("is symmetric around zero", () => {
    const [lo, hi] = deltaDomainFor([1, -2, 0.5]);
    expect(lo).toBeCloseTo(-hi);
    expect(hi).toBeGreaterThanOrEqual(2);
  });

  it("falls back to a minimum span with no data", () => {
    expect(deltaDomainFor([])).toEqual([-0.1, 0.1]);
  });
});
