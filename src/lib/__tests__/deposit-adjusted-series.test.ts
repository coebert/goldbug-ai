import { describe, expect, it } from "vitest";
import {
  buildDepositAdjustedSeries,
  trailingAdjustedPct,
} from "../deposit-adjusted-series";

const pts = (rows: [string, number][]) =>
  rows.map(([date, equity]) => ({ date, equity }));

describe("buildDepositAdjustedSeries", () => {
  it("pass-through when no deposits: adjusted === equity, pct is raw %", () => {
    const s = buildDepositAdjustedSeries(
      pts([
        ["2026-07-22", 1000],
        ["2026-07-23", 1100],
      ]),
      [],
    );
    expect(s[1].adjusted).toBe(1100);
    expect(s[1].pct).toBeCloseTo(10, 5);
  });

  it("deposit dated ON startDate is baked into baseline (ignored)", () => {
    const s = buildDepositAdjustedSeries(
      pts([
        ["2026-07-22", 1000],
        ["2026-07-23", 1050],
      ]),
      [{ date: "2026-07-22", amount: 500 }],
    );
    expect(s[0].adjusted).toBe(1000);
    expect(s[1].adjusted).toBe(1050);
    expect(s[1].pct).toBeCloseTo(5, 5);
  });

  it("mid-series deposit is subtracted from every subsequent point", () => {
    // £200 deposit on day 2 that exactly funds the equity bump →
    // adjusted stays flat and pct stays at 0. Subsequent trading
    // gain is scaled against the capital-adjusted baseline
    // (baseline + cumulative flows) so a large deposit cannot
    // divide small trading PnL by a tiny pre-deposit baseline.
    const s = buildDepositAdjustedSeries(
      pts([
        ["2026-07-22", 1000],
        ["2026-07-23", 1200], // +£200 raw
        ["2026-07-24", 1210], // + £10 trading
      ]),
      [{ date: "2026-07-23", amount: 200 }],
    );
    expect(s[1].adjusted).toBe(1000);
    expect(s[1].pct).toBeCloseTo(0, 5);
    expect(s[2].adjusted).toBe(1010);
    // 10 trading PnL on capital of 1000 + 200 = 1200.
    expect(s[2].pct).toBeCloseTo((10 / 1200) * 100, 5);
  });

  it("withdrawal (negative) is added back — trading PnL survives it", () => {
    const s = buildDepositAdjustedSeries(
      pts([
        ["2026-07-22", 1000],
        ["2026-07-23", 970], // trading +£30, then £60 withdrawn
      ]),
      [{ date: "2026-07-23", amount: -60 }],
    );
    expect(s[1].adjusted).toBe(1030);
    // 30 trading PnL on capital of 1000 − 60 = 940.
    expect(s[1].pct).toBeCloseTo((30 / 940) * 100, 5);
  });

  it("multiple deposits accumulate", () => {
    const s = buildDepositAdjustedSeries(
      pts([
        ["2026-07-22", 1000],
        ["2026-07-23", 1500],
        ["2026-07-24", 2050],
      ]),
      [
        { date: "2026-07-23", amount: 500 },
        { date: "2026-07-24", amount: 500 },
      ],
    );
    expect(s[1].pct).toBeCloseTo(0, 5);
    expect(s[2].adjusted).toBe(1050);
    // 50 trading PnL on capital of 1000 + 500 + 500 = 2000.
    expect(s[2].pct).toBeCloseTo((50 / 2000) * 100, 5);
  });


  it("deposits before startDate are ignored (already in baseline)", () => {
    const s = buildDepositAdjustedSeries(
      pts([
        ["2026-07-22", 1000],
        ["2026-07-23", 1050],
      ]),
      [{ date: "2026-07-20", amount: 999 }],
    );
    expect(s[1].adjusted).toBe(1050);
    expect(s[1].pct).toBeCloseTo(5, 5);
  });

  it("non-finite amounts are dropped", () => {
    const s = buildDepositAdjustedSeries(
      pts([
        ["2026-07-22", 1000],
        ["2026-07-23", 1050],
      ]),
      [
        { date: "2026-07-23", amount: Number.NaN },
        { date: "2026-07-23", amount: Number.POSITIVE_INFINITY },
      ],
    );
    expect(s[1].adjusted).toBe(1050);
  });

  it("baseline <= 0 → pct is 0 (safe divide)", () => {
    const s = buildDepositAdjustedSeries(
      pts([
        ["2026-07-22", 0],
        ["2026-07-23", 100],
      ]),
      [],
    );
    expect(s[1].pct).toBe(0);
  });

  it("trailingAdjustedPct matches computeModeSummary intent", () => {
    // Same fixture as mode-summary "deposit + trading gain".
    const pct = trailingAdjustedPct(
      pts([
        ["2026-07-22", 300],
        ["2026-07-23", 520],
      ]),
      [{ date: "2026-07-23", amount: 200 }],
    );
    // Trading = +£20 on capital 300 + 200 = 500 → 4%.
    expect(pct).toBeCloseTo((20 / 500) * 100, 5);
  });


  it("empty input → empty output", () => {
    expect(buildDepositAdjustedSeries([], [])).toEqual([]);
    expect(trailingAdjustedPct([], [])).toBe(0);
  });
});
