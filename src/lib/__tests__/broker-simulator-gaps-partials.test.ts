// Worst-case price gaps + partial fills, run as a SEQUENCE.
//
// Real markets don't move smoothly: a name can gap -60% overnight, gap
// back +150% the next session, and only ever fill a sliver of the
// requested size because the book is thin. Each of those is already
// covered in isolation; what was untested is the *sequence* — feeding
// one session's final state into the next session's gapped prices and
// thin liquidity, over and over.
//
// The guarantees asserted after every session, and again at the end:
//   - no borrow      cash never dips below 0, and no BUY spends more
//                    than the cash that existed before the step
//   - no short       no holding quantity ever goes negative
//   - snapshot math  totalValue === cash + Σ qty*mark, to float precision
//   - liquidity cap  fillQuantity never exceeds availableVolume *
//                    maxParticipationRate for that step
//   - position cap   a SELL never exceeds the quantity actually held
//   - NAV cap        no single name exceeds its share cap of total NAV
//                    at the moment its BUY is authorised

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  simulateBrokerExecution,
  type Frictions,
  type SimDecision,
  type SimSnapshot,
  type SimState,
} from "../broker-simulator";
import { assertExecutionInvariants } from "../execution-invariants";

/** Punitive but survivable cost model — worst case we'd plausibly see. */
const HARSH: Frictions = {
  commissionBps: 100, // 1%
  minCommission: 15,
  buyTaxBps: 50, // stamp duty
  slippageBps: 100, // 1% adverse on every fill
  impactPerUnit: 0.05,
};

/** Gap ladder: crash, dead-cat bounce, halt-like flat, melt-up, crash again. */
const GAP_PATH = [1, 0.4, 0.62, 0.62, 1.55, 0.3];

const SYMBOLS = ["AAA", "BBB", "CCC"] as const;

function markPrices(step: number, base: Record<string, number>): Record<string, number> {
  const g = GAP_PATH[Math.min(step, GAP_PATH.length - 1)];
  const out: Record<string, number> = {};
  for (const s of SYMBOLS) out[s] = base[s] * g;
  return out;
}

/** Assert the per-step guarantees that the invariant checker doesn't own. */
function assertFillCaps(
  snaps: SimSnapshot[],
  volume: Record<string, number>,
  participation: number,
) {
  for (const s of snaps) {
    expect(Number.isFinite(s.fillQuantity)).toBe(true);
    expect(s.fillQuantity).toBeGreaterThanOrEqual(0);
    expect(s.fillQuantity).toBeLessThanOrEqual(s.requestedQuantity + 1e-9);
    const cap = volume[s.symbol] * participation;
    expect(s.fillQuantity).toBeLessThanOrEqual(cap + 1e-9);
    if (s.fillQuantity < s.requestedQuantity - 1e-9) expect(s.partial).toBe(true);
    for (const h of s.holdings) expect(h.quantity).toBeGreaterThanOrEqual(0);
    expect(s.cash).toBeGreaterThanOrEqual(-1e-9);
  }
}

describe("broker simulator — worst-case gaps and partial fills in sequence", () => {
  it("survives a crash/bounce/melt-up/crash ladder with thin books intact", () => {
    const base: Record<string, number> = { AAA: 100, BBB: 40, CCC: 12.5 };
    const volume: Record<string, number> = { AAA: 30, BBB: 55, CCC: 400 };
    const participation = 0.1;

    let state: SimState = { cash: 25_000, holdings: [] };

    for (let step = 0; step < GAP_PATH.length; step++) {
      const marks = markPrices(step, base);
      // Alternate accumulate / de-risk sessions so both sides of the
      // book get exercised against the gapped marks.
      const side = step % 2 === 0 ? "BUY" : "SELL";
      const decisions: SimDecision[] = SYMBOLS.map((sym, i) => ({
        id: `s${step}-${sym}`,
        symbol: sym,
        side,
        // Deliberately oversized so liquidity/cash/position all bite.
        quantity: 500 + i * 250,
        price: marks[sym],
      }));

      const res = simulateBrokerExecution(state, decisions, {
        markPrices: marks,
        frictions: HARSH,
        liquidity: { availableVolume: volume, maxParticipationRate: participation },
        timeSliceUnfilled: true,
        timeSliceMaxAttempts: 3,
      });

      assertExecutionInvariants({
        initial: state,
        decisions,
        snapshots: res.snapshots,
        rejections: res.rejections,
        markPrices: marks,
      });
      assertFillCaps(res.snapshots, volume, participation);

      // No borrow, no short, at the session boundary too.
      expect(res.finalState.cash).toBeGreaterThanOrEqual(0);
      for (const h of res.finalState.holdings) {
        expect(h.quantity).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(h.avgCost)).toBe(true);
      }
      state = res.finalState;
    }

    // The book survived the whole ladder with a solvent, finite state.
    expect(Number.isFinite(state.cash)).toBe(true);
  });

  it("a -99% gap down then +900% gap up never lets a SELL short the book", () => {
    const start: SimState = { cash: 1_000, holdings: [{ symbol: "AAA", quantity: 10, avgCost: 100 }] };
    // Session 1: collapse to 1.00 and try to dump 10x the position.
    const s1 = simulateBrokerExecution(
      start,
      [{ id: "d1", symbol: "AAA", side: "SELL", quantity: 100, price: 1 }],
      { markPrices: { AAA: 1 }, frictions: HARSH },
    );
    expect(s1.snapshots[0].fillQuantity).toBeLessThanOrEqual(10);
    expect(s1.snapshots[0].truncationReason).toBe("position");
    expect(s1.finalState.holdings.every((h) => h.quantity >= 0)).toBe(true);

    // Session 2: melt-up to 10.00, buy far beyond the cash we have.
    const s2 = simulateBrokerExecution(
      s1.finalState,
      [{ id: "d2", symbol: "AAA", side: "BUY", quantity: 10_000, price: 10 }],
      { markPrices: { AAA: 10 }, frictions: HARSH },
    );
    assertExecutionInvariants({
      initial: s1.finalState,
      decisions: [{ id: "d2", symbol: "AAA", side: "BUY", quantity: 10_000, price: 10 }],
      snapshots: s2.snapshots,
      rejections: s2.rejections,
      markPrices: { AAA: 10 },
    });
    expect(s2.finalState.cash).toBeGreaterThanOrEqual(0);
  });

  it("keeps every name under its NAV cap even when a gap re-rates the book mid-sequence", () => {
    const NAV_CAP = 0.25;
    let state: SimState = { cash: 40_000, holdings: [] };
    const base: Record<string, number> = { AAA: 100, BBB: 40, CCC: 12.5 };

    for (let step = 0; step < GAP_PATH.length; step++) {
      const marks = markPrices(step, base);
      const nav =
        state.cash +
        state.holdings.reduce((a, h) => a + h.quantity * (marks[h.symbol] ?? h.avgCost), 0);

      // Size each BUY to the remaining NAV-cap headroom for that name.
      const decisions: SimDecision[] = SYMBOLS.flatMap((sym) => {
        const held = state.holdings.find((h) => h.symbol === sym)?.quantity ?? 0;
        const heldValue = held * marks[sym];
        const headroom = Math.max(0, nav * NAV_CAP - heldValue);
        const qty = Math.floor(headroom / marks[sym]);
        return qty > 0 ? [{ id: `${step}-${sym}`, symbol: sym, side: "BUY" as const, quantity: qty, price: marks[sym] }] : [];
      });
      if (decisions.length === 0) continue;

      const res = simulateBrokerExecution(state, decisions, {
        markPrices: marks,
        frictions: HARSH,
        liquidity: { availableVolume: { AAA: 200, BBB: 200, CCC: 900 }, maxParticipationRate: 0.25 },
      });
      assertExecutionInvariants({
        initial: state,
        decisions,
        snapshots: res.snapshots,
        rejections: res.rejections,
        markPrices: marks,
      });

      // Cap holds at authorisation time (a later gap may re-rate a name
      // above the cap — that's a market move, not an over-buy).
      for (const s of res.snapshots) {
        const pos = s.holdings.find((h) => h.symbol === s.symbol)?.quantity ?? 0;
        expect(pos * marks[s.symbol]).toBeLessThanOrEqual(nav * NAV_CAP + 1e-6);
      }
      state = res.finalState;
    }
    expect(state.cash).toBeGreaterThanOrEqual(0);
  });

  it("property: random gap paths with random thin books never break an invariant", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.05, max: 4, noNaN: true }), { minLength: 2, maxLength: 6 }),
        fc.double({ min: 0.5, max: 500, noNaN: true }),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        fc.double({ min: 1, max: 5_000, noNaN: true }),
        (gaps, price0, participation, volume) => {
          let state: SimState = { cash: 20_000, holdings: [] };
          let price = price0;
          for (let i = 0; i < gaps.length; i++) {
            price = Math.max(1e-4, price * gaps[i]);
            const side = i % 2 === 0 ? "BUY" : "SELL";
            const decisions: SimDecision[] = [
              { id: `p${i}`, symbol: "AAA", side, quantity: 1_000, price },
            ];
            const res = simulateBrokerExecution(state, decisions, {
              markPrices: { AAA: price },
              frictions: HARSH,
              liquidity: { availableVolume: { AAA: volume }, maxParticipationRate: participation },
            });
            assertExecutionInvariants({
              initial: state,
              decisions,
              snapshots: res.snapshots,
              rejections: res.rejections,
              markPrices: { AAA: price },
            });
            for (const s of res.snapshots) {
              expect(s.fillQuantity).toBeLessThanOrEqual(volume * participation + 1e-9);
              expect(s.cash).toBeGreaterThanOrEqual(-1e-9);
            }
            expect(res.finalState.cash).toBeGreaterThanOrEqual(0);
            for (const h of res.finalState.holdings) expect(h.quantity).toBeGreaterThanOrEqual(0);
            state = res.finalState;
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
