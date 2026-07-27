// Locks the "portfolio card % change excludes cash deposits" contract.
//
// Each home-page portfolio card renders a range % (1W / 1M / 3M / 1Y /
// All) derived from that portfolio's own equity snapshots. Deposits
// inflate raw equity but must NOT be counted as trading profit unless
// the user explicitly opts in via the "Include deposits in % change"
// toggle. These tests exercise the shared helper the card uses so a
// regression in either the helper or the wiring surfaces here.

import { describe, expect, it } from "vitest";
import { computeCardRangePct } from "../card-range-pct";

const pts = (rows: [string, number][]) =>
  rows.map(([date, value]) => ({ date, value }));

describe("computeCardRangePct — deposit exclusion contract", () => {
  it("no deposits: default and toggle-on produce the same raw %", () => {
    const s = pts([
      ["2026-07-22", 1000],
      ["2026-07-23", 1100],
    ]);
    expect(computeCardRangePct(s, [], false)).toBeCloseTo(10, 5);
    expect(computeCardRangePct(s, [], true)).toBeCloseTo(10, 5);
  });

  it("mid-window deposit funding the entire bump → default shows 0%", () => {
    // £200 injected on day 2, equity up by exactly £200: pure cash-in,
    // no trading. Card must not report a +20% "gain".
    const s = pts([
      ["2026-07-22", 1000],
      ["2026-07-23", 1200],
    ]);
    const deposits = [{ date: "2026-07-23", amount: 200 }];
    expect(computeCardRangePct(s, deposits, false)).toBeCloseTo(0, 5);
  });

  it("toggle ON reinstates the raw % including deposit inflation", () => {
    const s = pts([
      ["2026-07-22", 1000],
      ["2026-07-23", 1200],
    ]);
    const deposits = [{ date: "2026-07-23", amount: 200 }];
    expect(computeCardRangePct(s, deposits, true)).toBeCloseTo(20, 5);
  });

  it("trading gain on top of a deposit is preserved (default)", () => {
    // £200 deposit + £10 trading gain. Capital = 1000 + 200 = 1200,
    // so trading return = 10/1200 ≈ 0.833%.
    const s = pts([
      ["2026-07-22", 1000],
      ["2026-07-23", 1210],
    ]);
    const deposits = [{ date: "2026-07-23", amount: 200 }];
    expect(computeCardRangePct(s, deposits, false)).toBeCloseTo(
      (10 / 1200) * 100,
      5,
    );
  });

  it("withdrawal preserves trading PnL (default)", () => {
    // Trading +£30, then £60 withdrawn → adjusted +£30 on capital
    // 1000 − 60 = 940.
    const s = pts([
      ["2026-07-22", 1000],
      ["2026-07-23", 970],
    ]);
    const deposits = [{ date: "2026-07-23", amount: -60 }];
    expect(computeCardRangePct(s, deposits, false)).toBeCloseTo(
      (30 / 940) * 100,
      5,
    );
    // Toggle ON: raw -3%.
    expect(computeCardRangePct(s, deposits, true)).toBeCloseTo(-3, 5);
  });


  it("deposit dated on/before baseline is baked in and ignored", () => {
    const s = pts([
      ["2026-07-22", 1000],
      ["2026-07-23", 1050],
    ]);
    const deposits = [
      { date: "2026-07-20", amount: 999 }, // pre-baseline
      { date: "2026-07-22", amount: 500 }, // on baseline
    ];
    expect(computeCardRangePct(s, deposits, false)).toBeCloseTo(5, 5);
  });

  it("multiple accumulating deposits are all netted (default)", () => {
    const s = pts([
      ["2026-07-22", 1000],
      ["2026-07-23", 1500],
      ["2026-07-24", 2050],
    ]);
    const deposits = [
      { date: "2026-07-23", amount: 500 },
      { date: "2026-07-24", amount: 500 },
    ];
    // Adjusted last = 2050 - 1000 = 1050 trading PnL of £50 on
    // capital 1000 + 500 + 500 = 2000 → +2.5%.
    expect(computeCardRangePct(s, deposits, false)).toBeCloseTo(2.5, 5);
    // Toggle ON: raw +105%.
    expect(computeCardRangePct(s, deposits, true)).toBeCloseTo(105, 5);
  });

  it("empty series → null (card renders empty state)", () => {
    expect(computeCardRangePct([], [], false)).toBeNull();
    expect(computeCardRangePct([], [{ date: "2026-07-23", amount: 100 }], true)).toBeNull();
  });


  it("baseline <= 0 → 0% (safe divide, no NaN/Infinity leak into the card)", () => {
    const s = pts([
      ["2026-07-22", 0],
      ["2026-07-23", 100],
    ]);
    expect(computeCardRangePct(s, [], false)).toBe(0);
    expect(computeCardRangePct(s, [{ date: "2026-07-23", amount: 50 }], false)).toBe(0);
  });

  it("applies uniformly across every range (1W/1M/3M/1Y/All) — same slice = same %", () => {
    // The card slices sparkSeries by range BEFORE calling the helper,
    // so the contract must hold for any slice length the range picker
    // can produce. Simulate five range slices from a longer series.
    const full = pts([
      ["2026-06-01", 1000],
      ["2026-06-15", 1050],
      ["2026-07-01", 1100],
      ["2026-07-15", 1300], // £200 deposit on this date
      ["2026-07-22", 1310],
      ["2026-07-23", 1320],
    ]);
    const deposits = [{ date: "2026-07-15", amount: 200 }];

    // 1W-ish slice: baseline post-deposit → no netting needed.
    const wk = full.slice(-2);
    expect(computeCardRangePct(wk, deposits, false)).toBeCloseTo(
      ((1320 - 1310) / 1310) * 100,
      5,
    );

    // 1M-ish slice: baseline pre-deposit → mid-window deposit netted.
    // slice(-4) starts at 2026-07-01 (value 1100); adjusted last =
    // 1320 - 200 = 1120 (trading PnL £20) on capital 1100 + 200.
    const mo = full.slice(-4);
    expect(computeCardRangePct(mo, deposits, false)).toBeCloseTo(
      ((1120 - 1100) / (1100 + 200)) * 100,
      5,
    );

    // All / 3M slice: baseline 2026-06-01 → mid-window £200 deposit netted.
    // Adjusted last = 1320 - 200 = 1120 (trading PnL £120) on capital
    // 1000 + 200 = 1200 → +10%.
    expect(computeCardRangePct(full, deposits, false)).toBeCloseTo(10, 5);
    // Toggle ON: raw +32%.
    expect(computeCardRangePct(full, deposits, true)).toBeCloseTo(32, 5);
  });


  it("toggle is per-render pure: same inputs → same output on every call", () => {
    const s = pts([
      ["2026-07-22", 1000],
      ["2026-07-23", 1200],
    ]);
    const deposits = [{ date: "2026-07-23", amount: 200 }];
    for (let i = 0; i < 5; i++) {
      expect(computeCardRangePct(s, deposits, false)).toBeCloseTo(0, 5);
      expect(computeCardRangePct(s, deposits, true)).toBeCloseTo(20, 5);
    }
  });
});
