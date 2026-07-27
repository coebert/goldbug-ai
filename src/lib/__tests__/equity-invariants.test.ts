// Unit tests for the pure equity-invariant checker. These pin the
// contract that the writeCashSyncSnapshot integration layer relies on.

import { describe, expect, it } from "vitest";
import { checkEquityInvariants, summariseInvariantResult } from "@/lib/equity-invariants";

describe("checkEquityInvariants — pure invariants", () => {
  it("passes on a well-formed snapshot", () => {
    const r = checkEquityInvariants({ cash: 100, holdingsValue: 200, totalValue: 300 });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.worstSeverity).toBeNull();
  });

  it("derives total_value when omitted", () => {
    const r = checkEquityInvariants({ cash: 50, holdingsValue: 150 });
    expect(r.ok).toBe(true);
  });

  it("flags invested > 100% (the user-reported bug)", () => {
    // 143.6% invested + 110% cash — Invested is quoted in native-currency
    // sums while total_value came from the (FX-normalised) broker. Both
    // percentages exceed 100% and the identity is broken.
    const r = checkEquityInvariants({ cash: 1100, holdingsValue: 1436, totalValue: 1000 });
    expect(r.ok).toBe(false);
    const codes = r.violations.map((v) => v.code).sort();
    expect(codes).toContain("invested_exceeds_equity");
    expect(codes).toContain("cash_exceeds_equity");
    expect(codes).toContain("total_mismatch");
    expect(r.worstSeverity).toBe("error");
  });

  it("flags negative cash", () => {
    const r = checkEquityInvariants({ cash: -10, holdingsValue: 100, totalValue: 90 });
    expect(r.violations.some((v) => v.code === "cash_negative")).toBe(true);
  });

  it("flags negative holdings", () => {
    const r = checkEquityInvariants({ cash: 200, holdingsValue: -50, totalValue: 150 });
    expect(r.violations.some((v) => v.code === "holdings_negative")).toBe(true);
  });

  it("flags total_value ≠ cash + holdings_value", () => {
    const r = checkEquityInvariants({ cash: 100, holdingsValue: 100, totalValue: 250 });
    const v = r.violations.find((x) => x.code === "total_mismatch");
    expect(v).toBeDefined();
    expect(v?.context.diff).toBe(50);
  });

  it("does NOT flag sub-tolerance FX rounding drift", () => {
    // 0.30 diff within default 0.5 tolerance.
    const r = checkEquityInvariants({ cash: 100.1, holdingsValue: 199.6, totalValue: 300 });
    expect(r.ok).toBe(true);
  });

  it("does NOT flag 100.4% invested within default pct tolerance", () => {
    // 100.4% invested is within the 0.5% pctTolerance band.
    const r = checkEquityInvariants({ cash: 0, holdingsValue: 1004, totalValue: 1000 }, { tolerance: 10 });
    expect(r.violations.some((v) => v.code === "invested_exceeds_equity")).toBe(false);
  });

  it("flags NaN inputs as non_finite and stops further checks", () => {
    const r = checkEquityInvariants({ cash: Number.NaN, holdingsValue: 100, totalValue: 100 });
    expect(r.ok).toBe(false);
    // Non-finite short-circuits, so we should see exactly the non_finite
    // violation and none of the percentage/mismatch ones.
    expect(r.violations.every((v) => v.code === "non_finite")).toBe(true);
  });

  it("flags Infinity as non_finite", () => {
    const r = checkEquityInvariants({ cash: 100, holdingsValue: Number.POSITIVE_INFINITY });
    expect(r.violations.some((v) => v.code === "non_finite")).toBe(true);
  });

  it("summariseInvariantResult produces a stable one-liner", () => {
    const ok = checkEquityInvariants({ cash: 10, holdingsValue: 20, totalValue: 30 });
    expect(summariseInvariantResult(ok)).toBe("equity invariants ok");
    const bad = checkEquityInvariants({ cash: 989, holdingsValue: 1436, totalValue: 1000 });
    expect(summariseInvariantResult(bad)).toMatch(/^equity invariants FAILED:/);
    expect(summariseInvariantResult(bad)).toContain("invested_exceeds_equity");
  });

  it("every violation carries portfolio_id and snapshot_date in context", () => {
    const r = checkEquityInvariants({
      portfolioId: "abc",
      snapshotDate: "2026-07-27",
      currency: "GBP",
      cash: -5,
      holdingsValue: 100,
      totalValue: 100,
    });
    for (const v of r.violations) {
      expect(v.context.portfolio_id).toBe("abc");
      expect(v.context.snapshot_date).toBe("2026-07-27");
      expect(v.context.currency).toBe("GBP");
    }
  });
});
