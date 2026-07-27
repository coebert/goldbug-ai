// Fixtures covering multiple deposit types (deposit, withdrawal, mixed,
// sub-cent, zero, same-day) and out-of-order event timestamps. Verifies
// computeModeSummary still nets external cash flows out of pnl/pct and
// remains order-independent for the deposits input array.

import { describe, expect, it } from "vitest";
import {
  computeModeSummary,
  type DepositEvent,
  type SummaryPortfolio,
  type SummarySeriesRow,
} from "../mode-summary";

const REAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SIM_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const portfolios: SummaryPortfolio[] = [
  { id: REAL_A, mode: "live_prod" },
  { id: REAL_B, mode: "live_prod" },
  { id: SIM_A, mode: "paper" },
];

const series: SummarySeriesRow[] = [
  { date: "2026-07-20", [REAL_A]: 300, [REAL_B]: 500, [SIM_A]: 1000 },
  { date: "2026-07-21", [REAL_A]: 305, [REAL_B]: 495, [SIM_A]: 1010 },
  // Big jump on real driven mostly by external cash-flows below.
  { date: "2026-07-22", [REAL_A]: 520, [REAL_B]: 445, [SIM_A]: 1250 },
];

// Deliberately shuffled: withdrawal listed before the deposits it
// offsets, out-of-window events sprinkled in, sub-cent + zero amounts.
const shuffledDeposits: DepositEvent[] = [
  // Out-of-window (before prev snapshot) — must be ignored.
  { portfolio_id: REAL_A, date: "2026-07-19", amount: 999 },
  // Withdrawal on the last day for REAL_B.
  { portfolio_id: REAL_B, date: "2026-07-22", amount: -50 },
  // Zero-value event: must be a no-op.
  { portfolio_id: REAL_A, date: "2026-07-22", amount: 0 },
  // Sub-cent deposit into REAL_A.
  { portfolio_id: REAL_A, date: "2026-07-22", amount: 0.004 },
  // On prevDate itself — excluded (already baked into previous).
  { portfolio_id: REAL_A, date: "2026-07-21", amount: 123 },
  // Two same-day deposits into REAL_A that together add £200.
  { portfolio_id: REAL_A, date: "2026-07-22", amount: 150 },
  { portfolio_id: REAL_A, date: "2026-07-22", amount: 50 },
  // Sim-side deposit — must not leak into the real summary.
  { portfolio_id: SIM_A, date: "2026-07-22", amount: 200 },
  // Out-of-window (after last snapshot) — must be ignored.
  { portfolio_id: REAL_A, date: "2026-07-23", amount: 400 },
];

describe("computeModeSummary — mixed deposit fixtures & event ordering", () => {
  it("nets deposits + withdrawals in the real mode window", () => {
    const s = computeModeSummary(series, portfolios, shuffledDeposits)!;
    // Real now = 520 + 445 = 965; previous = 305 + 495 = 800.
    // Net real deposits in window = 200 + 0.004 + 0 − 50 = 150.004.
    // Trading pnl = (965 − 800) − 150.004 = 14.996. Denominator is
    // capital-adjusted (prev + net flows = 950.004).
    expect(s.real.now).toBe(965);
    expect(s.real.pnl).toBeCloseTo(14.996, 6);
    expect(s.real.pct).toBeCloseTo((14.996 / 950.004) * 100, 6);
  });

  it("sim mode nets its own deposit and ignores real-side events", () => {
    const s = computeModeSummary(series, portfolios, shuffledDeposits)!;
    // Sim now = 1250; previous = 1010; deposit = 200 → pnl = 40.
    // Capital-adjusted denominator = 1010 + 200 = 1210.
    expect(s.sim.now).toBe(1250);
    expect(s.sim.pnl).toBeCloseTo(40, 6);
    expect(s.sim.pct).toBeCloseTo((40 / 1210) * 100, 6);
  });


  it("result is invariant to deposit event ordering", () => {
    const forward = computeModeSummary(series, portfolios, shuffledDeposits)!;
    const reversed = computeModeSummary(
      series,
      portfolios,
      [...shuffledDeposits].reverse(),
    )!;
    const sorted = computeModeSummary(
      series,
      portfolios,
      [...shuffledDeposits].sort((a, b) => a.date.localeCompare(b.date)),
    )!;
    expect(reversed).toEqual(forward);
    expect(sorted).toEqual(forward);
  });

  it("withdrawal-only window produces positive trading pnl", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-21", [REAL_A]: 1000 },
        { date: "2026-07-22", [REAL_A]: 950 },
      ],
      [{ id: REAL_A, mode: "live_prod" }],
      [
        // Withdrawal of £100 in-window; trading actually gained £50.
        { portfolio_id: REAL_A, date: "2026-07-22", amount: -100 },
        // Out-of-window withdrawal — ignored.
        { portfolio_id: REAL_A, date: "2026-07-20", amount: -500 },
      ],
    )!;
    // rawDelta = −50; netDeposits = −100 → pnl = 50.
    // Capital-adjusted denom = 1000 − 100 = 900.
    expect(s.real.pnl).toBeCloseTo(50, 6);
    expect(s.real.pct).toBeCloseTo((50 / 900) * 100, 6);
  });


  it("includeDeposits:true short-circuits netting even with mixed events", () => {
    const s = computeModeSummary(series, portfolios, shuffledDeposits, {
      includeDeposits: true,
    })!;
    expect(s.real.pnl).toBe(965 - 800); // 165
    expect(s.sim.pnl).toBe(1250 - 1010); // 240
  });

  it("out-of-order series rows: only the last two chronological rows drive the delta window", () => {
    // Note: computeModeSummary uses the last two rows of the given series
    // in array order as (prev, last). Callers are expected to feed a sorted
    // series (buildAllPortfoliosEquity does so). This test pins that
    // contract explicitly so a regression that started sorting internally
    // — or a caller feeding unsorted data — surfaces here.
    const unsorted: SummarySeriesRow[] = [series[2], series[0], series[1]];
    const s = computeModeSummary(unsorted, portfolios, shuffledDeposits)!;
    // Last two rows in array order are 2026-07-20 (prev) and 2026-07-21 (last).
    // Real: now = 305+495 = 800; prev = 300+500 = 800; rawDelta = 0.
    // In-window real deposit: the 07-21 £123 into REAL_A (strictly after
    // prev 07-20, ≤ last 07-21). All other real events are dated 07-22
    // (out of window) or 07-19 (before prev). pnl = 0 − 123 = −123.
    expect(s.real.now).toBe(800);
    expect(s.real.pnl).toBeCloseTo(-123, 6);
    // Capital-adjusted denominator = 800 + 123 = 923.
    expect(s.real.pct).toBeCloseTo((-123 / 923) * 100, 6);
  });

});
