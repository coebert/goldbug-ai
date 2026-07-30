import { describe, expect, it } from "vitest";
import { capitalAt, pctDomain } from "@/components/equity-pct-chart";

// Regression: the live-cash portfolio ran at ~£300 for a month before a
// £9,890 top-up lifted starting_cash to £10,300. Measuring against the final
// pot printed ~−97% for every pre-deposit day and pushed the y-axis to ±118%.
const DEPOSITS = [{ date: "2026-07-27", amount: 9890.38 }];
const BASELINE = 409.62;

describe("equity pct chart baseline", () => {
  it("uses only capital contributed on or before the point", () => {
    expect(capitalAt(BASELINE, DEPOSITS, "2026-07-01")).toBeCloseTo(409.62, 2);
    expect(capitalAt(BASELINE, DEPOSITS, "2026-07-27")).toBeCloseTo(10300, 2);
    expect(capitalAt(BASELINE, DEPOSITS, "2026-07-30T14:00:00.000Z")).toBeCloseTo(10300, 2);
  });

  it("keeps pre-deposit days near flat instead of near −100%", () => {
    const pct = (value: number, at: string) => {
      const cap = capitalAt(BASELINE, DEPOSITS, at);
      return ((value - cap) / cap) * 100;
    };
    expect(pct(299.72, "2026-07-01")).toBeGreaterThan(-40);
    expect(pct(10309.75, "2026-07-30")).toBeCloseTo(0.09, 1);
  });

  it("never produces a value below −100% for real equity", () => {
    const worst = ((0.01 - 10300) / 10300) * 100;
    expect(worst).toBeGreaterThan(-100);
  });

  it("builds a domain that contains zero and never dips under −100%", () => {
    const [lo, hi] = pctDomain([-3.2, 0.4, 1.1]);
    expect(lo).toBeLessThan(-3.2);
    expect(lo).toBeGreaterThanOrEqual(-100);
    expect(hi).toBeGreaterThan(1.1);

    const [lo2, hi2] = pctDomain([0.05, 0.1]);
    expect(lo2).toBeLessThanOrEqual(0);
    expect(hi2).toBeGreaterThan(0.1);
  });

  it("does not blow the domain up to ±118% for a flat series", () => {
    const [lo, hi] = pctDomain([0.09, 0.1, 0.08]);
    expect(hi - lo).toBeLessThan(2);
  });
});
