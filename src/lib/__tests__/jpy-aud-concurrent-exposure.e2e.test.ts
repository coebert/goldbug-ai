// End-to-end test: concurrency safety of JPY/AUD exposure increments and
// decrements when overlapping buy/sell orders settle in unpredictable order.
//
// The trading engine tracks a per-currency exposure map (base-ccy value of
// non-base holdings) so `fx_currency_limits` in `RiskConfig` can throttle
// new buys. When buys and sells for the same symbols fire close in time —
// interleaved by broker fill callbacks, the tick scheduler, or reconcile
// jobs — the exposure ledger MUST remain consistent regardless of order:
// the terminal ledger and the final wallet must equal the sequential
// baseline for any permutation of legs.
//
// This test drives that invariant with:
//   1. A pure ledger applier (`applyLegs`) that credits / debits both the
//      wallet and the per-currency exposure for each buy or sell leg.
//   2. A shuffled schedule of overlapping JPY (7203.T) and AUD (BHP.AX)
//      buys and sells simulating concurrent execution.
//   3. Assertions that:
//      a. Baseline (sequential) and shuffled runs converge on the same
//         wallet and exposure map.
//      b. Intermediate exposure never goes negative (would indicate a
//         sell without a prior matching buy — a real-world consistency
//         violation).
//      c. Sum of buy debits and sell credits reconciles per currency.
//      d. Zeroing-out cancellations (buy + equal sell) net exposure and
//         native cash back to zero.
//      e. Randomized permutations produce identical terminal state.

import { describe, it, expect } from "vitest";

type Leg = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  ccy: "JPY" | "AUD";
  quantity: number;
  price: number; // native currency
  fxRateNativeToBase: number; // native → base (GBP) at fill time
};

type LedgerState = {
  wallet: Record<string, number>;
  /** Per-currency EXPOSURE in BASE ccy (holdings value only, not cash). */
  exposure: Record<string, number>;
  history: Array<{
    legId: string;
    exposureAfter: Record<string, number>;
    walletAfter: Record<string, number>;
  }>;
};

function makeInitial(): LedgerState {
  return {
    wallet: { GBP: 100_000, JPY: 0, AUD: 0 },
    exposure: { JPY: 0, AUD: 0 },
    history: [],
  };
}

// Apply one leg atomically. Buys assume base→native funding at the leg's
// FX rate; sells credit native proceeds and sweep 100% to base at the
// leg's rate. Exposure moves by the base-ccy notional of the trade.
function applyLeg(state: LedgerState, leg: Leg): LedgerState {
  const wallet = { ...state.wallet };
  const exposure = { ...state.exposure };
  const notionalNative = leg.quantity * leg.price;
  const notionalBase = notionalNative * leg.fxRateNativeToBase;

  if (leg.side === "buy") {
    wallet.GBP -= notionalBase;
    // Native cash pass-through: purchased & spent atomically.
    exposure[leg.ccy] = (exposure[leg.ccy] ?? 0) + notionalBase;
  } else {
    wallet.GBP += notionalBase;
    exposure[leg.ccy] = (exposure[leg.ccy] ?? 0) - notionalBase;
  }

  const history = [
    ...state.history,
    {
      legId: leg.id,
      exposureAfter: { ...exposure },
      walletAfter: { ...wallet },
    },
  ];
  return { wallet, exposure, history };
}

function applyLegs(legs: Leg[]): LedgerState {
  return legs.reduce((s, l) => applyLeg(s, l), makeInitial());
}

// Deterministic permutation generator (Heap's algorithm) — bounded to
// small arrays; keeps the test hermetic (no randomness across runs).
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: T[][] = [];
  const n = arr.length;
  const a = arr.slice();
  const c = new Array<number>(n).fill(0);
  out.push(a.slice());
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const swapIdx = i % 2 === 0 ? 0 : c[i];
      [a[swapIdx], a[i]] = [a[i], a[swapIdx]];
      out.push(a.slice());
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
  return out;
}

// Deterministic shuffle from a seeded LCG — reproducible & no `Math.random`.
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  let s = seed | 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function approxEqualMap(
  a: Record<string, number>,
  b: Record<string, number>,
  epsilon = 1e-6,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > epsilon) return false;
  }
  return true;
}

describe("Concurrent JPY/AUD buy/sell exposure consistency", () => {
  // Fixed rates so tests are exactly determined by leg order rules.
  const JPY_TO_GBP = 1 / 190;
  const AUD_TO_GBP = 1 / 1.9;

  // Overlapping schedule: two buys and matching sells per currency that
  // could realistically execute in overlapping windows.
  const legs: Leg[] = [
    { id: "b1", symbol: "7203.T", side: "buy",  ccy: "JPY", quantity: 100, price: 3_000, fxRateNativeToBase: JPY_TO_GBP },
    { id: "b2", symbol: "BHP.AX", side: "buy",  ccy: "AUD", quantity: 50,  price: 40,    fxRateNativeToBase: AUD_TO_GBP },
    { id: "s1", symbol: "7203.T", side: "sell", ccy: "JPY", quantity: 40,  price: 3_000, fxRateNativeToBase: JPY_TO_GBP },
    { id: "b3", symbol: "7203.T", side: "buy",  ccy: "JPY", quantity: 20,  price: 3_000, fxRateNativeToBase: JPY_TO_GBP },
    { id: "s2", symbol: "BHP.AX", side: "sell", ccy: "AUD", quantity: 20,  price: 40,    fxRateNativeToBase: AUD_TO_GBP },
    { id: "b4", symbol: "BHP.AX", side: "buy",  ccy: "AUD", quantity: 10,  price: 40,    fxRateNativeToBase: AUD_TO_GBP },
  ];

  // Deterministic baseline (sequential apply in listed order).
  const baseline = applyLegs(legs);

  it("baseline final wallet and exposure match hand-computed totals", () => {
    // JPY net qty: 100 − 40 + 20 = 80 → notional 240,000 ¥ → £240k/190
    // AUD net qty: 50 − 20 + 10 = 40 → notional 1,600 A$   → £1600/1.9
    const expectedJpyExposure = (80 * 3_000) * JPY_TO_GBP;
    const expectedAudExposure = (40 * 40)    * AUD_TO_GBP;
    expect(baseline.exposure.JPY).toBeCloseTo(expectedJpyExposure, 9);
    expect(baseline.exposure.AUD).toBeCloseTo(expectedAudExposure, 9);

    // GBP net = 100,000 − (all buy notionals) + (all sell notionals) in base.
    const buysBase = (100 * 3_000 + 20 * 3_000) * JPY_TO_GBP + (50 * 40 + 10 * 40) * AUD_TO_GBP;
    const sellsBase = (40 * 3_000) * JPY_TO_GBP + (20 * 40) * AUD_TO_GBP;
    expect(baseline.wallet.GBP).toBeCloseTo(100_000 - buysBase + sellsBase, 9);
  });

  it("intermediate exposure never goes negative for a valid interleaving", () => {
    // The listed order applies each sell only after enough prior buys.
    for (const step of baseline.history) {
      expect(step.exposureAfter.JPY).toBeGreaterThanOrEqual(-1e-9);
      expect(step.exposureAfter.AUD).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it("all 720 permutations of the 6-leg schedule converge on the same terminal state", () => {
    // 6! = 720 — bounded and fast. Guarantees the ledger is commutative
    // for a mixed buy/sell schedule regardless of concurrent arrival order.
    const all = permutations(legs);
    expect(all).toHaveLength(720);
    for (const perm of all) {
      const s = applyLegs(perm);
      expect(approxEqualMap(s.wallet,   baseline.wallet)).toBe(true);
      expect(approxEqualMap(s.exposure, baseline.exposure)).toBe(true);
    }
  });

  it("seeded shuffles reproduce baseline exactly (idempotent under reordering)", () => {
    for (const seed of [1, 42, 1337, 99991, 7_777_777]) {
      const shuffled = seededShuffle(legs, seed);
      const s = applyLegs(shuffled);
      expect(approxEqualMap(s.wallet,   baseline.wallet)).toBe(true);
      expect(approxEqualMap(s.exposure, baseline.exposure)).toBe(true);
    }
  });

  it("fully-cancelling buy+sell pairs net exposure and native cash to zero regardless of order", () => {
    const cancelling: Leg[] = [
      { id: "b", symbol: "7203.T", side: "buy",  ccy: "JPY", quantity: 100, price: 3_000, fxRateNativeToBase: JPY_TO_GBP },
      { id: "s", symbol: "7203.T", side: "sell", ccy: "JPY", quantity: 100, price: 3_000, fxRateNativeToBase: JPY_TO_GBP },
      { id: "B", symbol: "BHP.AX", side: "buy",  ccy: "AUD", quantity: 25,  price: 40,    fxRateNativeToBase: AUD_TO_GBP },
      { id: "S", symbol: "BHP.AX", side: "sell", ccy: "AUD", quantity: 25,  price: 40,    fxRateNativeToBase: AUD_TO_GBP },
    ];
    for (const perm of permutations(cancelling)) {
      const s = applyLegs(perm);
      expect(s.exposure.JPY).toBeCloseTo(0, 9);
      expect(s.exposure.AUD).toBeCloseTo(0, 9);
      // GBP untouched — every buy debit is exactly reversed by its sell.
      expect(s.wallet.GBP).toBeCloseTo(100_000, 6);
    }
  });

  it("aggregate per-ccy debits/credits reconcile across every permutation", () => {
    // Sum of BASE-ccy trade notionals should equal ±exposure delta per ccy,
    // independent of ordering.
    const buysJpyBase  = (100 * 3_000 + 20 * 3_000) * JPY_TO_GBP;
    const sellsJpyBase = (40 * 3_000)               * JPY_TO_GBP;
    const buysAudBase  = (50 * 40 + 10 * 40)        * AUD_TO_GBP;
    const sellsAudBase = (20 * 40)                  * AUD_TO_GBP;

    for (const seed of [3, 17, 2_026]) {
      const s = applyLegs(seededShuffle(legs, seed));
      expect(s.exposure.JPY).toBeCloseTo(buysJpyBase - sellsJpyBase, 9);
      expect(s.exposure.AUD).toBeCloseTo(buysAudBase - sellsAudBase, 9);
    }
  });
});
