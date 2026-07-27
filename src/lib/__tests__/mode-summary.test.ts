// Deposits must NOT inflate the reported profit / percentage change.
// Verifies computeModeSummary nets external cash flows out of pnl and pct.

import { describe, expect, it } from "vitest";
import { computeModeSummary } from "../mode-summary";

const REAL = "11111111-1111-4111-8111-111111111111";
const SIM = "22222222-2222-4222-8222-222222222222";

const portfolios = [
  { id: REAL, mode: "live_prod" },
  { id: SIM, mode: "paper" },
];

describe("computeModeSummary — excludes deposits from pnl & pct", () => {
  it("returns null when there are no rows or no portfolios", () => {
    expect(computeModeSummary([], portfolios)).toBeNull();
    expect(
      computeModeSummary(
        [{ date: "2026-07-23", [REAL]: 300 }],
        [],
      ),
    ).toBeNull();
  });

  it("no deposits → pnl equals raw delta (baseline behavior preserved)", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 300 },
        { date: "2026-07-23", [REAL]: 315 },
      ],
      portfolios,
    )!;
    expect(s.real.now).toBe(315);
    expect(s.real.pnl).toBe(15);
    expect(s.real.pct).toBeCloseTo(5, 5);
  });

  it("£200 real deposit between snapshots is netted out → shows 0 pnl, 0 pct", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 300 },
        { date: "2026-07-23", [REAL]: 500 },
      ],
      portfolios,
      [{ portfolio_id: REAL, date: "2026-07-23", amount: 200 }],
    )!;
    expect(s.real.now).toBe(500);
    expect(s.real.pnl).toBe(0);
    expect(s.real.pct).toBe(0);
  });

  it("deposit + real trading gain: pnl reflects only the trading portion", () => {
    // Prev 300 → now 520; £200 was deposited between, so trading = +£20.
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 300 },
        { date: "2026-07-23", [REAL]: 520 },
      ],
      portfolios,
      [{ portfolio_id: REAL, date: "2026-07-23", amount: 200 }],
    )!;
    expect(s.real.pnl).toBe(20);
    // Denominator is capital-adjusted (prev + net deposits = 500) so
    // large deposits cannot inflate the % against a tiny pre-deposit
    // baseline. £20 trading on £500 employed capital = 4%.
    expect(s.real.pct).toBeCloseTo((20 / 500) * 100, 5);
  });


  it("deposit dated ON prev snapshot is already baked in — not double-subtracted", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 500 }, // already includes the £200 deposit
        { date: "2026-07-23", [REAL]: 515 }, // trading gain +£15
      ],
      portfolios,
      [{ portfolio_id: REAL, date: "2026-07-22", amount: 200 }],
    )!;
    expect(s.real.pnl).toBe(15);
    expect(s.real.pct).toBeCloseTo(3, 5);
  });

  it("deposit dated AFTER the last snapshot is ignored", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 300 },
        { date: "2026-07-23", [REAL]: 315 },
      ],
      portfolios,
      [{ portfolio_id: REAL, date: "2026-07-24", amount: 500 }],
    )!;
    expect(s.real.pnl).toBe(15);
  });

  it("withdrawal (negative amount) is added back to pnl", () => {
    // Prev 500 → now 480 after withdrawing £30; trading actually +£10.
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 500 },
        { date: "2026-07-23", [REAL]: 480 },
      ],
      portfolios,
      [{ portfolio_id: REAL, date: "2026-07-23", amount: -30 }],
    )!;
    expect(s.real.pnl).toBe(10);
    // Denominator adjusted for the withdrawn capital: 500 − 30 = 470.
    expect(s.real.pct).toBeCloseTo((10 / 470) * 100, 5);
  });


  it("sim deposits are netted from sim, not from real", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [SIM]: 1000, [REAL]: 300 },
        { date: "2026-07-23", [SIM]: 1500, [REAL]: 315 },
      ],
      portfolios,
      [{ portfolio_id: SIM, date: "2026-07-23", amount: 500 }],
    )!;
    // Sim: raw +500, deposit 500 → pnl 0.
    expect(s.sim.pnl).toBe(0);
    expect(s.sim.pct).toBe(0);
    // Real: untouched.
    expect(s.real.pnl).toBe(15);
    expect(s.real.pct).toBeCloseTo(5, 5);
  });

  it("multiple deposits in the window are summed", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 300 },
        { date: "2026-07-23", [REAL]: 800 },
      ],
      portfolios,
      [
        { portfolio_id: REAL, date: "2026-07-23", amount: 200 },
        { portfolio_id: REAL, date: "2026-07-23", amount: 300 },
      ],
    )!;
    expect(s.real.pnl).toBe(0);
  });

  it("only one snapshot exists → no adjustment possible, pnl stays 0", () => {
    const s = computeModeSummary(
      [{ date: "2026-07-23", [REAL]: 500 }],
      portfolios,
      [{ portfolio_id: REAL, date: "2026-07-23", amount: 200 }],
    )!;
    expect(s.real.now).toBe(500);
    expect(s.real.pnl).toBe(0);
    expect(s.real.pct).toBe(0);
  });

  it("non-finite deposit amounts are ignored", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 300 },
        { date: "2026-07-23", [REAL]: 315 },
      ],
      portfolios,
      [
        { portfolio_id: REAL, date: "2026-07-23", amount: Number.NaN },
        { portfolio_id: REAL, date: "2026-07-23", amount: Number.POSITIVE_INFINITY },
      ],
    )!;
    expect(s.real.pnl).toBe(15);
  });

  it("counts real and sim portfolios correctly regardless of deposits", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 300, [SIM]: 1000 },
        { date: "2026-07-23", [REAL]: 500, [SIM]: 1500 },
      ],
      portfolios,
      [
        { portfolio_id: REAL, date: "2026-07-23", amount: 200 },
        { portfolio_id: SIM, date: "2026-07-23", amount: 500 },
      ],
    )!;
    expect(s.real.count).toBe(1);
    expect(s.sim.count).toBe(1);
    expect(s.real.pnl).toBe(0);
    expect(s.sim.pnl).toBe(0);
  });
});
