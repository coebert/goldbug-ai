// Contract test: the shared money formatter used by the home-page
// portfolio cards MUST render 2dp, halfExpand rounding, en-GB
// grouping, coerce -0 → 0, and safely fall through to "—" on
// non-finite input. Locking this at the unit layer keeps the
// headline £ number visually consistent across every card.

import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyAmount } from "../format-money";

describe("formatMoneyAmount — rounding + grouping contract", () => {
  it("always renders exactly 2 fraction digits", () => {
    expect(formatMoneyAmount(0)).toBe("0.00");
    expect(formatMoneyAmount(1)).toBe("1.00");
    expect(formatMoneyAmount(1.5)).toBe("1.50");
  });

  it("adds en-GB thousands separators", () => {
    expect(formatMoneyAmount(1_234.5)).toBe("1,234.50");
    expect(formatMoneyAmount(1_234_567.89)).toBe("1,234,567.89");
    expect(formatMoneyAmount(-1_234_567.89)).toBe("-1,234,567.89");
  });

  it("rounds halfExpand (0.005 → 0.01, -0.005 → -0.01)", () => {
    expect(formatMoneyAmount(0.005)).toBe("0.01");
    expect(formatMoneyAmount(-0.005)).toBe("-0.01");
    expect(formatMoneyAmount(1.235)).toBe("1.24");
    expect(formatMoneyAmount(1.234)).toBe("1.23");
  });

  it("coerces -0 to 0 so no card ever renders '-0.00'", () => {
    expect(formatMoneyAmount(-0)).toBe("0.00");
    // Rounds to exactly zero from the negative side must not carry
    // a sign either.
    expect(formatMoneyAmount(-0.0001)).toBe("0.00");
  });

  it("returns '—' for null / undefined / non-finite input", () => {
    expect(formatMoneyAmount(null)).toBe("—");
    expect(formatMoneyAmount(undefined)).toBe("—");
    expect(formatMoneyAmount(Number.NaN)).toBe("—");
    expect(formatMoneyAmount(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatMoneyAmount(Number.NEGATIVE_INFINITY)).toBe("—");
  });
});

describe("formatMoney — currency prefix", () => {
  it("prefixes with GBP by default", () => {
    expect(formatMoney(1_234.5)).toBe("GBP 1,234.50");
  });

  it("uses the supplied currency prefix", () => {
    expect(formatMoney(99.9, "USD")).toBe("USD 99.90");
    expect(formatMoney(0, "EUR")).toBe("EUR 0.00");
  });

  it("propagates '—' for missing values (no stray 'GBP —')", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(Number.NaN, "USD")).toBe("—");
  });
});
