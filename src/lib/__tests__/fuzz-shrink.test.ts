import { describe, expect, it } from "vitest";
import { attempt, failureSignature, minimize, shrinkList, shrinkNumber } from "./fuzz-shrink";

/**
 * The minimizer is test infrastructure, so it needs its own tests: a shrinker
 * that silently stops early, or that drifts onto a different failure, would
 * quietly make every fuzz report misleading.
 */

type Case = { xs: number[]; cap: number };

const shrinkCase = (c: Case): Case[] => [
  ...shrinkList(c.xs).map((xs) => ({ ...c, xs })),
  ...shrinkNumber(c.cap, { min: 0, integer: true }).map((cap) => ({ ...c, cap })),
  ...c.xs.flatMap((x, i) =>
    shrinkNumber(x, { min: 0, integer: true }).map((v) => ({
      ...c,
      xs: c.xs.map((y, j) => (j === i ? v : y)),
    })),
  ),
];

describe("fuzz counterexample minimization", () => {
  it("captures an assertion message instead of throwing", () => {
    expect(attempt(() => expect(1).toBe(1))).toBeNull();
    expect(attempt(() => expect(1).toBe(2))).toContain("2");
  });

  it("treats messages differing only in numbers as the same failure", () => {
    expect(failureSignature("negative cash at step 41: case 3")).toBe(
      failureSignature("negative cash at step 7: case 812"),
    );
    expect(failureSignature("negative cash at step 4")).not.toBe(failureSignature("peak over cap at step 4"));
  });

  it("shrinks a large planted counterexample to the minimal one", () => {
    // Bug under test: any element above the cap is a violation.
    const check = (c: Case) => (c.xs.some((x) => x > c.cap) ? `value above cap ${c.cap}` : null);
    const input: Case = { xs: [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3], cap: 6 };

    const min = minimize(input, check, shrinkCase);

    expect(min.value.xs).toHaveLength(1);
    expect(min.value.cap).toBe(0);
    expect(min.value.xs[0]).toBe(1);
    expect(check(min.value)).not.toBeNull();
    expect(min.steps).toBeGreaterThan(0);
  });

  it("never returns a case that stops failing", () => {
    // Narrow bug: only a specific pair triggers it, so naive shrinking that
    // accepts any smaller list would lose the reproduction.
    const check = (c: Case) => (c.xs.includes(11) && c.xs.includes(22) ? "pair present" : null);
    const input: Case = { xs: [1, 11, 2, 3, 4, 22, 5, 6, 7, 8], cap: 9 };

    const min = minimize(input, check, shrinkCase);

    expect(check(min.value)).not.toBeNull();
    expect(min.value.xs).toEqual([11, 22]);
  });

  it("does not drift onto a different invariant while shrinking", () => {
    // Both bugs are reachable; shrinking must stay on the one first observed.
    const check = (c: Case) => {
      if (c.xs.length > 4) return `too many values: ${c.xs.length}`;
      if (c.xs.some((x) => x < 0)) return `negative value present`;
      return null;
    };
    const input: Case = { xs: [1, 2, 3, 4, 5, 6, -7, 8], cap: 3 };

    const min = minimize(input, check, shrinkCase);

    expect(min.signature).toBe(failureSignature("too many values: 8"));
    expect(min.value.xs.length).toBe(5); // one more than the threshold
    expect(check(min.value)).toContain("too many values");
  });

  it("is deterministic and idempotent", () => {
    const check = (c: Case) => (c.xs.reduce((a, b) => a + b, 0) > 10 ? "sum too large" : null);
    const input: Case = { xs: [4, 4, 4, 4, 4, 4, 4, 4], cap: 5 };

    const a = minimize(input, check, shrinkCase);
    const b = minimize(input, check, shrinkCase);
    expect(b.value).toEqual(a.value);

    // Re-minimizing an already minimal case must not shrink it further.
    expect(minimize(a.value, check, shrinkCase).value).toEqual(a.value);
  });

  it("returns the input untouched when nothing fails", () => {
    const input: Case = { xs: [1, 2], cap: 5 };
    const min = minimize(input, () => null, shrinkCase);
    expect(min.value).toBe(input);
    expect(min.tried).toBe(false);
    expect(min.steps).toBe(0);
  });

  it("respects the step budget on pathological shrink spaces", () => {
    const check = (c: Case) => (c.xs.length > 1 ? "still big" : null);
    const input: Case = { xs: Array.from({ length: 400 }, (_, i) => i + 1), cap: 100 };
    const min = minimize(input, check, shrinkCase, { maxSteps: 5 });
    expect(min.steps).toBeLessThanOrEqual(5);
    expect(check(min.value)).not.toBeNull();
  });

  it("proposes only strictly simpler candidates", () => {
    expect(shrinkList([1, 2, 3, 4]).every((c) => c.length > 0 && c.length < 4)).toBe(true);
    expect(shrinkList([1])).toEqual([]);
    expect(shrinkNumber(8, { min: 0 }).every((v) => v < 8 && v >= 0)).toBe(true);
    expect(shrinkNumber(0, { min: 0 })).toEqual([]);
    expect(shrinkNumber(NaN)).toEqual([0, 1]);
  });
});
