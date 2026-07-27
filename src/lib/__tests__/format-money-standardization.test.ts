// Contract: FX/GBX rounding + formatting is centralised.
//
// Every portfolio-metric surface (headline, tiles, per-position rows,
// multi-currency breakdown) MUST feed the shared helpers below so that:
//   1. `Σ rounded rows === rounded total` (no ±0.01 display drift)
//   2. GBX / GBp pence quotes are folded into GBP before formatting
//   3. `roundMoney` and `formatMoneyAmount` agree on the display grid
//
// These invariants were violated before (screenshot bug: rows summing
// to a value ~1p off the Invested tile) and are now impossible by
// construction — this test file locks the guarantees.

import { describe, expect, it } from "vitest";
import {
  allocateRoundedShares,
  formatMoney,
  formatMoneyAmount,
  formatMoneySigned,
  normalizeGbxToBase,
  roundMoney,
} from "../format-money";

describe("roundMoney — same grid as the display formatter", () => {
  it("rounds halfExpand at 2dp", () => {
    expect(roundMoney(1.234)).toBe(1.23);
    expect(roundMoney(1.235)).toBe(1.24);
    expect(roundMoney(-1.235)).toBe(-1.24);
    expect(roundMoney(0.005)).toBe(0.01);
  });
  it("coerces -0 → 0", () => {
    expect(Object.is(roundMoney(-0), 0)).toBe(true);
    expect(Object.is(roundMoney(-0.0001), 0)).toBe(true);
  });
  it("null / NaN / Infinity → 0", () => {
    expect(roundMoney(null)).toBe(0);
    expect(roundMoney(Number.NaN)).toBe(0);
    expect(roundMoney(Number.POSITIVE_INFINITY)).toBe(0);
  });
  it("agrees with formatMoneyAmount at 2dp", () => {
    for (const v of [0.005, 1.234, 1.235, 12.345, 1234.567, -0.005, -1234.567]) {
      expect(formatMoneyAmount(roundMoney(v))).toBe(formatMoneyAmount(v));
    }
  });
});

describe("normalizeGbxToBase — GBX / GBp pence into GBP", () => {
  it("divides by 100 for GBX / GBp → GBP", () => {
    expect(normalizeGbxToBase(2500, "GBX", "GBP")).toBe(25);
    expect(normalizeGbxToBase(2500, "GBp", "GBP")).toBe(25);
    expect(normalizeGbxToBase(2500, "gbx", "gbp")).toBe(25);
  });
  it("passes non-GBX values through unchanged", () => {
    expect(normalizeGbxToBase(178.2, "USD", "GBP")).toBe(178.2);
    expect(normalizeGbxToBase(25, "GBP", "GBP")).toBe(25);
    expect(normalizeGbxToBase(100, "EUR", "GBP")).toBe(100);
  });
  it("does not fold GBX into non-GBP base (needs real FX)", () => {
    expect(normalizeGbxToBase(2500, "GBX", "USD")).toBe(2500);
  });
});

describe("allocateRoundedShares — rows sum bit-exactly to total", () => {
  it("splits invested across positions with zero display drift", () => {
    // The screenshot bug: three rows scale to ~£100.62666… each, naïve
    // 2dp rounding yields 100.63 * 3 = 301.89 (fine here) — but the
    // fixed case £301.89 / 7 rows drifts. Test both.
    for (const [total, weights] of [
      [301.89, [55.4, 356.4]],
      [301.89, [1, 1, 1, 1, 1, 1, 1]],
      [1234.56, [3, 5, 7, 11, 13]],
      [0.03, [1, 1, 1]],
      [100, [0.1, 0.1, 0.1, 0.1, 0.1]],
    ] as const) {
      const rows = allocateRoundedShares(weights, total);
      const sum = rows.reduce((s, v) => s + v, 0);
      expect(roundMoney(sum)).toBe(roundMoney(total));
      // Each row rounds cleanly to 2dp.
      for (const r of rows) expect(r).toBe(roundMoney(r));
    }
  });

  it("returns zeros when rawSum is zero (never NaN)", () => {
    expect(allocateRoundedShares([0, 0], 100)).toEqual([0, 0]);
    expect(allocateRoundedShares([], 100)).toEqual([]);
  });

  it("handles a single row (allocates the full total)", () => {
    expect(allocateRoundedShares([42], 100)).toEqual([100]);
  });

  it("fuzz: 500 random splits — Σrows === roundMoney(total) always", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let iter = 0; iter < 500; iter++) {
      const n = 1 + Math.floor(rand() * 8);
      const weights = Array.from({ length: n }, () => rand() * 1000);
      const total = rand() * 100_000;
      const rows = allocateRoundedShares(weights, total);
      const sum = rows.reduce((s, v) => s + v, 0);
      expect(roundMoney(sum)).toBe(roundMoney(total));
    }
  });
});

describe("formatMoney / formatMoneySigned share the roundMoney grid", () => {
  it("signed formatter uses explicit + and Unicode minus", () => {
    expect(formatMoneySigned(0)).toBe("GBP 0.00");
    expect(formatMoneySigned(1.5)).toBe("+GBP 1.50");
    expect(formatMoneySigned(-1.5)).toBe("\u2212GBP 1.50");
    expect(formatMoneySigned(-0.0001)).toBe("GBP 0.00");
  });
  it("propagates '—' for missing values", () => {
    expect(formatMoneySigned(null)).toBe("—");
    expect(formatMoney(null, "USD")).toBe("—");
  });
});
