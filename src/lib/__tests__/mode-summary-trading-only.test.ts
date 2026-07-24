// Invariant: computeModeSummary MUST exclude external deposits and
// withdrawals from both `pnl` and `pct`, so the % change reflects
// trading PnL only. A cash deposit must never masquerade as profit.
//
// Complements mode-summary.test.ts (scenario coverage) with:
//   1. Aggregation across MULTIPLE portfolios in the same mode.
//   2. Boundary dates around the (prev, last] deposit window.
//   3. Signed mixing (deposit + withdrawal in the same window).
//   4. Property-based: adding a deposit to a window while simultaneously
//      bumping the same-mode equity by the same amount leaves the
//      trading PnL and pct BYTE-IDENTICAL to the no-deposit baseline.
//   5. Property-based: pct is always finite and independent of the
//      deposit amount when the trading portion is held constant.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeModeSummary } from "../mode-summary";

const REAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SIM = "22222222-2222-4222-8222-222222222222";

const portfolios = [
  { id: REAL_A, mode: "live_prod" },
  { id: REAL_B, mode: "live_prod" },
  { id: SIM, mode: "paper" },
];

describe("computeModeSummary — pct reflects trading PnL only (invariant)", () => {
  it("multiple real portfolios: deposits into ONE are netted from the mode aggregate", () => {
    // Trading PnL: A +£10, B +£5 → total +£15 on a £700 baseline (≈2.143%).
    // A also received a £100 deposit inside the window.
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL_A]: 300, [REAL_B]: 400 },
        { date: "2026-07-23", [REAL_A]: 410, [REAL_B]: 405 },
      ],
      portfolios,
      [{ portfolio_id: REAL_A, date: "2026-07-23", amount: 100 }],
    )!;
    expect(s.real.now).toBe(815);
    expect(s.real.pnl).toBe(15); // 815 − 700 − 100
    expect(s.real.pct).toBeCloseTo((15 / 700) * 100, 5);
    expect(s.real.count).toBe(2);
  });

  it("deposit + withdrawal net to zero → pct matches raw trading %", () => {
    // Prev 500 → now 520; +£50 deposit and -£50 withdrawal same day.
    // Trading = +£20 → pct = 4%.
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL_A]: 500 },
        { date: "2026-07-23", [REAL_A]: 520 },
      ],
      portfolios,
      [
        { portfolio_id: REAL_A, date: "2026-07-23", amount: 50 },
        { portfolio_id: REAL_A, date: "2026-07-23", amount: -50 },
      ],
    )!;
    expect(s.real.pnl).toBe(20);
    expect(s.real.pct).toBeCloseTo(4, 5);
  });

  it("deposit dated ONE DAY before prev is NOT in the window (already in baseline)", () => {
    // Prev row baseline is 2026-07-22; a deposit on 2026-07-21 is
    // already reflected in that baseline. The window (prev, last] must
    // not double-subtract it.
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL_A]: 500 },
        { date: "2026-07-23", [REAL_A]: 530 },
      ],
      portfolios,
      [{ portfolio_id: REAL_A, date: "2026-07-21", amount: 200 }],
    )!;
    expect(s.real.pnl).toBe(30);
    expect(s.real.pct).toBeCloseTo(6, 5);
  });

  it("deposit dated ON the last snapshot IS in the window and IS netted", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL_A]: 500 },
        { date: "2026-07-23", [REAL_A]: 700 },
      ],
      portfolios,
      [{ portfolio_id: REAL_A, date: "2026-07-23", amount: 200 }],
    )!;
    expect(s.real.pnl).toBe(0);
    expect(s.real.pct).toBe(0);
  });

  it("cross-mode: a REAL deposit must NEVER affect sim pct, and vice versa", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL_A]: 300, [SIM]: 1000 },
        { date: "2026-07-23", [REAL_A]: 800, [SIM]: 1050 },
      ],
      portfolios,
      [
        { portfolio_id: REAL_A, date: "2026-07-23", amount: 500 }, // real deposit
        { portfolio_id: SIM, date: "2026-07-23", amount: 40 },     // sim deposit
      ],
    )!;
    // Real trading = 0; sim trading = 10.
    expect(s.real.pnl).toBe(0);
    expect(s.real.pct).toBe(0);
    expect(s.sim.pnl).toBe(10);
    expect(s.sim.pct).toBeCloseTo(1, 5);
  });

  it("deposit routed to an UNKNOWN portfolio id is ignored (defensive)", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL_A]: 500 },
        { date: "2026-07-23", [REAL_A]: 530 },
      ],
      portfolios,
      [{ portfolio_id: "ghost-id", date: "2026-07-23", amount: 999 }],
    )!;
    expect(s.real.pnl).toBe(30);
    expect(s.real.pct).toBeCloseTo(6, 5);
  });

  it("property: adding a deposit + equal same-mode equity bump yields IDENTICAL pnl/pct as no-deposit baseline", () => {
    // For any random baseline, trading delta, and deposit amount,
    // the pair (deposit=D, now=prev+trading+D) must be observationally
    // equivalent to (deposit=0, now=prev+trading). This is THE property
    // that "deposits don't inflate profits".
    fc.assert(
      fc.property(
        fc.double({ noDefaultInfinity: true, noNaN: true, min: 1, max: 1e9 }),   // prev > 0
        fc.double({ noDefaultInfinity: true, noNaN: true, min: -1e6, max: 1e6 }), // trading delta
        fc.double({ noDefaultInfinity: true, noNaN: true, min: -1e6, max: 1e6 }), // deposit
        (prev, trading, deposit) => {
          const withDeposit = computeModeSummary(
            [
              { date: "2026-07-22", [REAL_A]: prev },
              { date: "2026-07-23", [REAL_A]: prev + trading + deposit },
            ],
            portfolios,
            [{ portfolio_id: REAL_A, date: "2026-07-23", amount: deposit }],
          )!;
          const noDeposit = computeModeSummary(
            [
              { date: "2026-07-22", [REAL_A]: prev },
              { date: "2026-07-23", [REAL_A]: prev + trading },
            ],
            portfolios,
            [],
          )!;
          // Trading pnl and pct must match within floating-point tolerance
          // regardless of the deposit magnitude.
          const tol = Math.max(1e-6, Math.abs(trading) * 1e-9, Math.abs(deposit) * 1e-9);
          expect(Math.abs(withDeposit.real.pnl - noDeposit.real.pnl)).toBeLessThanOrEqual(tol);
          const pctTol = Math.max(1e-6, Math.abs(noDeposit.real.pct) * 1e-9);
          expect(Math.abs(withDeposit.real.pct - noDeposit.real.pct)).toBeLessThanOrEqual(pctTol);
          expect(Number.isFinite(withDeposit.real.pct)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: pct is invariant under deposit magnitude when trading portion is fixed", () => {
    // Two different deposit amounts, same underlying trading delta → same pct.
    fc.assert(
      fc.property(
        fc.double({ noDefaultInfinity: true, noNaN: true, min: 1, max: 1e6 }),
        fc.double({ noDefaultInfinity: true, noNaN: true, min: -1e5, max: 1e5 }),
        fc.double({ noDefaultInfinity: true, noNaN: true, min: -1e6, max: 1e6 }),
        fc.double({ noDefaultInfinity: true, noNaN: true, min: -1e6, max: 1e6 }),
        (prev, trading, dep1, dep2) => {
          const run = (dep: number) =>
            computeModeSummary(
              [
                { date: "2026-07-22", [REAL_A]: prev },
                { date: "2026-07-23", [REAL_A]: prev + trading + dep },
              ],
              portfolios,
              [{ portfolio_id: REAL_A, date: "2026-07-23", amount: dep }],
            )!.real.pct;
          const a = run(dep1);
          const b = run(dep2);
          const tol = Math.max(
            1e-6,
            (Math.abs(dep1) + Math.abs(dep2) + Math.abs(trading)) * 1e-9,
          );
          expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
          expect(Number.isFinite(a)).toBe(true);
          expect(Number.isFinite(b)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
