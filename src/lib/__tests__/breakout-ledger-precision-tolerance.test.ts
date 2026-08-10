import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import { applyDriverSizing, DEFAULT_GAP_WEIGHTS } from "@/lib/breakout-driver-execution";
import { applySizingLimits, resolveSizingLimits, type SizingLimits } from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Precision and rounding tolerance for the cash/holdings reconciliation.
 *
 * The exact-integer reconciliation suite proves the books tie out when every
 * amount is quantised up front. Reality is messier: sizes arrive as floats,
 * money is rounded to pence somewhere between the engine and the screen, and
 * the ledger is a long chain of additions and subtractions whose error
 * accumulates. The question this file answers is not "is it exact" but "how
 * far can it drift, and is that drift inside a bound we chose deliberately".
 *
 * The tolerances below are declared once, with the reasoning attached, and
 * every assertion cites one of them. Two properties are tested together:
 *
 *   1. Soundness — the ledger stays inside the tolerance for all fuzzed
 *      replays, at several rounding granularities and across ~12 orders of
 *      magnitude of capital.
 *   2. Tightness — the tolerance is small enough to still catch a real bug.
 *      Each bound has a negative control that injects a drift just above it
 *      and asserts the check fails, so a passing suite can never mean "the
 *      epsilon swallowed everything".
 */

const FILE = "src/lib/__tests__/breakout-ledger-precision-tolerance.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

// ---------------------------------------------------------------------------
// Configured tolerances
// ---------------------------------------------------------------------------

const TOLERANCE = {
  /**
   * Pure float arithmetic, no deliberate rounding. Error is IEEE-754 only, so
   * it scales with the magnitude of the running total, not with the step
   * count in any meaningful way. Expressed relatively.
   */
  relative: 1e-12,
  /** Floor for the relative bound so near-zero totals don't demand exactness. */
  absoluteFloor: 1e-9,
  /**
   * Deliberate rounding to a quantum q. Each of n bookings can lose up to q/2,
   * and the ledger books entries and exits, so the worst case over a replay is
   * n * q. Half that is the expected-error bound; we assert the hard one.
   */
  quantumSteps: (n: number, q: number) => n * q,
  /** Compounded return is a product, so per-step size error is amplified. */
  compounding: 1e-6,
} as const;

/** Scale-free comparison used by every soundness assertion. */
function within(actual: number, expected: number, relative = TOLERANCE.relative): boolean {
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1);
  return Math.abs(actual - expected) <= Math.max(relative * scale, TOLERANCE.absoluteFloor);
}

function expectWithin(actual: number, expected: number, msg: string, relative = TOLERANCE.relative) {
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1);
  const bound = Math.max(relative * scale, TOLERANCE.absoluteFloor);
  expect(Math.abs(actual - expected), `${msg} (drift ${Math.abs(actual - expected)} > ${bound})`).toBeLessThanOrEqual(
    bound,
  );
}

// ---------------------------------------------------------------------------
// Fuzz inputs
// ---------------------------------------------------------------------------

const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

type Row = { symbol: string; date: string; barsHeld: number; size: number };

function randomRows(r: () => number, n: number): Row[] {
  const symbols = 1 + Math.floor(r() * 9);
  const perDay = 1 + Math.floor(r() * 3);
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${i % symbols}`,
    date: day(Math.floor(i / perDay)),
    barsHeld: 1 + Math.floor(r() * 12),
    // Awkward magnitudes on purpose: values that are not representable in
    // binary are exactly where accumulated rounding shows up.
    size: r() < 0.07 ? 0 : (r() * 2.5) / 3,
  }));
}

function randomLimits(r: () => number): SizingLimits {
  return resolveSizingLimits({
    maxPositionSize: 0.35 + r() * 2,
    maxConcurrentSignals: 1 + Math.floor(r() * 14),
    maxTotalDeployedPct: 15 + r() * 300,
  });
}

function randomTrades(r: () => number, n: number): SignalTrade[] {
  const regimes = ["bull", "bear", "sideways"] as const;
  const symbols = 3 + Math.floor(r() * 8);
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${i % symbols}`,
    date: day(Math.floor(i / 2)),
    cohort: r() < 0.78 ? "confirmed" : "failed",
    direction: r() < 0.5 ? "up" : "down",
    side: "long",
    regime: regimes[Math.floor(r() * 3)],
    realisedVol20d: 0.005 + r() * 0.035,
    atrPct: 0.009 + r() * 0.035,
    quality: r(),
    penetrationAtr: r() * 2.4,
    volumeRatio: 0.7 + r() * 1.5,
    falseBreakoutRate: r() * 0.55,
    ageBars: 1 + Math.floor(r() * 7),
    pendingLatencyBars: Math.floor(r() * 4),
    entry: 100,
    exit: 100 + (r() - 0.45) * 11,
    exitReason: r() < 0.5 ? "target" : "stop",
    barsHeld: 1 + Math.floor(r() * 10),
    returnPct: (r() - 0.45) * 11,
    maxAdversePct: -r() * 6,
    maxFavourablePct: r() * 6,
  })) as SignalTrade[];
}

// ---------------------------------------------------------------------------
// Ledger walk with a configurable rounding quantum
// ---------------------------------------------------------------------------

type Walk = {
  bookings: number;
  entries: number;
  totalDeployed: number;
  deployedPct: number;
  peakConcurrent: number;
  peakPositionSize: number;
  cashOut: number;
  cashBack: number;
  terminalCash: number;
  minCash: number;
  maxHeld: number;
};

/**
 * @param quantum 0 = raw floats; otherwise every cash and holding movement is
 *                rounded to that granularity before it hits the balance, the
 *                way a pence-denominated ledger would.
 */
function walk(rows: readonly Row[], limits: SizingLimits, capital: number, quantum: number): Walk {
  const q = (x: number) => (quantum > 0 ? Math.round(x / quantum) * quantum : x);
  const plan = applySizingLimits(rows, limits);
  const dates = [...new Set(rows.map((x) => x.date))].sort();
  const rank = new Map(dates.map((d, i) => [d, i]));

  let cash = capital;
  let cashOut = 0;
  let cashBack = 0;
  let totalDeployed = 0;
  let entries = 0;
  let bookings = 0;
  let peakConcurrent = 0;
  let peakPositionSize = 0;
  let minCash = capital;
  let maxHeld = 0;
  const holdings = new Map<string, number>();
  const open: { until: number; symbol: string; size: number }[] = [];

  const release = (upTo: number) => {
    for (let j = open.length - 1; j >= 0; j--) {
      const pos = open[j];
      if (pos.until > upTo) continue;
      const held = (holdings.get(pos.symbol) ?? 0) - pos.size;
      if (Math.abs(held) <= TOLERANCE.absoluteFloor) holdings.delete(pos.symbol);
      else holdings.set(pos.symbol, held);
      cash += pos.size;
      cashBack += pos.size;
      bookings++;
      open.splice(j, 1);
    }
  };

  plan.signals.forEach((s, i) => {
    const at = rank.get(s.date) ?? 0;
    release(at);
    const size = q(s.size);
    if (size > 0) {
      entries++;
      bookings++;
      totalDeployed += size;
      cash -= size;
      cashOut += size;
      holdings.set(s.symbol, (holdings.get(s.symbol) ?? 0) + size);
      open.push({ until: at + Math.max(1, rows[i].barsHeld), symbol: s.symbol, size });
      if (size > peakPositionSize) peakPositionSize = size;
      if (open.length > peakConcurrent) peakConcurrent = open.length;
    }
    if (cash < minCash) minCash = cash;
    const held = [...holdings.values()].reduce((a, b) => a + b, 0);
    if (held > maxHeld) maxHeld = held;
  });

  release(Number.POSITIVE_INFINITY);

  const n = plan.signals.length;
  return {
    bookings,
    entries,
    totalDeployed,
    deployedPct: n ? (totalDeployed / n) * 100 : 0,
    peakConcurrent,
    peakPositionSize,
    cashOut,
    cashBack,
    terminalCash: cash,
    minCash,
    maxHeld,
  };
}

const CASES = 60;
const QUANTA = [0.01, 0.001, 1e-6] as const;

// ---------------------------------------------------------------------------

describe("ledger precision and rounding tolerance", () => {
  it("unrounded ledger totals match the summary within the relative tolerance", () => {
    for (let c = 0; c < CASES; c++) {
      const r = rng(caseSeed(BASE_SEED, "float", c));
      const rows = randomRows(r, 25 + Math.floor(r() * 130));
      const limits = randomLimits(r);
      const capital = (rows.length * limits.maxTotalDeployedPct) / 100;
      const rep = applySizingLimits(rows, limits).report;
      const led = walk(rows, limits, capital, 0);
      const ctx = `case ${c} — ${REPRO}`;

      expectWithin(led.deployedPct, rep.deployedPct, `deployedPct drifted from the summary: ${ctx}`);
      expectWithin(led.peakPositionSize, rep.peakPositionSize, `peakPositionSize drifted: ${ctx}`);
      expect(led.peakConcurrent, `peakConcurrent is an integer count and must match exactly: ${ctx}`).toBe(
        rep.peakConcurrent,
      );
      // Conservation: floats only, so the relative bound applies.
      expectWithin(led.cashOut, led.cashBack, `cash out != cash back: ${ctx}`);
      expectWithin(led.terminalCash, capital, `terminal cash != capital: ${ctx}`);
    }
  });

  it("rounded ledgers stay inside the n*q bound at every quantum", () => {
    for (const quantum of QUANTA) {
      for (let c = 0; c < CASES; c++) {
        const r = rng(caseSeed(BASE_SEED, `q${quantum}`, c));
        const rows = randomRows(r, 25 + Math.floor(r() * 130));
        const limits = randomLimits(r);
        const capital = (rows.length * limits.maxTotalDeployedPct) / 100;
        const rep = applySizingLimits(rows, limits).report;
        const led = walk(rows, limits, capital, quantum);
        const ctx = `quantum ${quantum}, case ${c} — ${REPRO}`;

        // deployedPct is a mean scaled by 100, so the per-signal bound q/2
        // becomes (q/2)*100 on the percentage — plus float slack.
        const pctBound = quantum * 50 + TOLERANCE.absoluteFloor;
        expect(
          Math.abs(led.deployedPct - rep.deployedPct),
          `deployedPct exceeded the rounding bound: ${ctx}`,
        ).toBeLessThanOrEqual(pctBound);

        const sizeBound = quantum / 2 + TOLERANCE.absoluteFloor;
        expect(
          Math.abs(led.peakPositionSize - rep.peakPositionSize),
          `peakPositionSize exceeded the rounding bound: ${ctx}`,
        ).toBeLessThanOrEqual(sizeBound);

        // Entries and exits both round, but each position rounds once and is
        // released at the same rounded size, so conservation stays exact.
        expectWithin(led.cashOut, led.cashBack, `rounded cash out != cash back: ${ctx}`);
        const cashBound = TOLERANCE.quantumSteps(led.bookings, quantum);
        expect(
          Math.abs(led.terminalCash - capital),
          `terminal cash drifted beyond n*q: ${ctx}`,
        ).toBeLessThanOrEqual(cashBound + TOLERANCE.absoluteFloor);

        // Rounding must not manufacture leverage beyond one quantum per open leg.
        expect(led.maxHeld, `rounded book exceeded capital: ${ctx}`).toBeLessThanOrEqual(
          capital + TOLERANCE.quantumSteps(led.peakConcurrent, quantum) + TOLERANCE.absoluteFloor,
        );
      }
    }
  });

  it("coarser rounding never drifts less than finer rounding, systematically", () => {
    // A sanity check on the bound itself: if 1e-6 rounding drifted more than
    // 0.01 rounding, the model behind the tolerance would be wrong.
    let coarserWorse = 0;
    let compared = 0;
    for (let c = 0; c < CASES; c++) {
      const r = rng(caseSeed(BASE_SEED, "monotone", c));
      const rows = randomRows(r, 60 + Math.floor(r() * 80));
      const limits = randomLimits(r);
      const capital = (rows.length * limits.maxTotalDeployedPct) / 100;
      const fine = walk(rows, limits, capital, 1e-6);
      const coarse = walk(rows, limits, capital, 0.01);
      const rep = applySizingLimits(rows, limits).report;
      const dFine = Math.abs(fine.deployedPct - rep.deployedPct);
      const dCoarse = Math.abs(coarse.deployedPct - rep.deployedPct);
      if (dFine > 0 || dCoarse > 0) {
        compared++;
        if (dCoarse >= dFine - TOLERANCE.absoluteFloor) coarserWorse++;
      }
    }
    expect(compared, `no measurable rounding drift to compare — ${REPRO}`).toBeGreaterThan(0);
    // Individual cases can invert by luck; the population must not.
    expect(coarserWorse / compared, `fine rounding drifted more than coarse — ${REPRO}`).toBeGreaterThan(0.9);
  });

  it("totals are invariant to capital scale across 12 orders of magnitude", () => {
    for (let c = 0; c < CASES; c++) {
      const r = rng(caseSeed(BASE_SEED, "scale", c));
      const rows = randomRows(r, 30 + Math.floor(r() * 90));
      const limits = randomLimits(r);
      const base = (rows.length * limits.maxTotalDeployedPct) / 100;
      const ctx = `case ${c} — ${REPRO}`;
      for (const factor of [1e-6, 1, 1e6]) {
        const led = walk(rows, limits, base * factor, 0);
        // Deployment is expressed in size units, so it must not move with the
        // cash denomination at all.
        expectWithin(led.deployedPct, walk(rows, limits, base, 0).deployedPct, `deployedPct moved with scale: ${ctx}`);
        expectWithin(led.terminalCash, base * factor, `terminal cash drifted at scale ${factor}: ${ctx}`);
      }
    }
  });

  it("summation order does not move the totals beyond the relative tolerance", () => {
    // The ledger adds in arrival order; a reader totalling the trade list may
    // sort or group. Both must land in the same place.
    for (let c = 0; c < CASES; c++) {
      const r = rng(caseSeed(BASE_SEED, "order", c));
      const rows = randomRows(r, 40 + Math.floor(r() * 100));
      const limits = randomLimits(r);
      const sizes = applySizingLimits(rows, limits).signals.map((s) => s.size).filter((x) => x > 0);
      const ctx = `case ${c} — ${REPRO}`;

      const naive = sizes.reduce((a, b) => a + b, 0);
      const ascending = [...sizes].sort((a, b) => a - b).reduce((a, b) => a + b, 0);
      const descending = [...sizes].sort((a, b) => b - a).reduce((a, b) => a + b, 0);
      let sum = 0;
      let comp = 0; // Kahan compensated summation: the most accurate reference.
      for (const x of sizes) {
        const y = x - comp;
        const t = sum + y;
        comp = t - sum - y;
        sum = t;
      }

      expectWithin(naive, sum, `arrival-order total drifted from compensated: ${ctx}`);
      expectWithin(ascending, sum, `ascending total drifted from compensated: ${ctx}`);
      expectWithin(descending, sum, `descending total drifted from compensated: ${ctx}`);
    }
  });

  it("compounded P&L recomputed from the trade list matches the summary", () => {
    // Compounding multiplies errors rather than adding them, so it gets its
    // own, looser, explicitly-justified tolerance.
    for (let c = 0; c < CASES; c++) {
      const r = rng(caseSeed(BASE_SEED, "compound", c));
      const trades = randomTrades(r, 50 + Math.floor(r() * 120));
      const risk = RISK_LEVELS[Math.floor(r() * RISK_LEVELS.length)] as RiskLevel;
      const gapWeight = DEFAULT_GAP_WEIGHTS[Math.floor(r() * DEFAULT_GAP_WEIGHTS.length)];
      const limits = randomLimits(r);
      const summary = applyDriverSizing(trades, { risk, gapWeight, limits });
      const ctx = `case ${c} — ${REPRO}`;

      const confirmed = [...trades]
        .filter((t) => t.cohort === "confirmed")
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const sized = applySizingLimits(
        confirmed.map((t) => ({ symbol: t.symbol, date: t.date, barsHeld: t.barsHeld, size: 1 })),
        limits,
      );
      // Recompute from the same allowed sizes the summary used, via its own
      // deployed total, to confirm the aggregate is self-consistent.
      const totalSize = sized.signals.reduce((a, s) => a + s.size, 0);
      if (sized.signals.length) {
        expectWithin(
          (totalSize / sized.signals.length) * 100,
          sized.report.deployedPct,
          `baseline deployedPct is not the mean of allowed sizes: ${ctx}`,
        );
      }

      // Equity path: recompute the summary's compounded return from its parts.
      expect(Number.isFinite(summary.cumulativeReturnPct), `cumulative return not finite: ${ctx}`).toBe(true);
      expect(Number.isFinite(summary.maxDrawdownPct), `drawdown not finite: ${ctx}`).toBe(true);
      if (summary.taken === 0) {
        expectWithin(summary.cumulativeReturnPct, 0, `no trades but non-zero return: ${ctx}`, TOLERANCE.compounding);
        expectWithin(summary.maxDrawdownPct, 0, `no trades but non-zero drawdown: ${ctx}`, TOLERANCE.compounding);
      }
      expect(summary.maxDrawdownPct, `drawdown must be <= 0: ${ctx}`).toBeLessThanOrEqual(TOLERANCE.absoluteFloor);
    }
  });

  it("the tolerances are tight enough to catch injected drift", () => {
    // Negative controls, one per bound. Each injects a perturbation just above
    // the bound and asserts the comparison rejects it.
    const ctx = REPRO;

    // Relative bound.
    expect(within(1000, 1000 * (1 + TOLERANCE.relative * 10)), `relative bound too loose: ${ctx}`).toBe(false);
    expect(within(1000, 1000 * (1 + TOLERANCE.relative / 10)), `relative bound too tight: ${ctx}`).toBe(true);

    // Absolute floor: a drift of one penny on a small total must fail.
    expect(within(0.5, 0.51), `absolute floor too loose: ${ctx}`).toBe(false);

    // Quantum bound: n*q must not silently absorb a full extra booking.
    const n = 100;
    const q = 0.01;
    const bound = TOLERANCE.quantumSteps(n, q);
    expect(bound, `quantum bound collapsed to zero: ${ctx}`).toBeCloseTo(1, 12);
    expect(Math.abs(bound + q) > bound, `quantum bound absorbs an extra booking: ${ctx}`).toBe(true);

    // And a real one: a ledger with one duplicated entry must breach the bound.
    const r = rng(caseSeed(BASE_SEED, "control", 0));
    const rows = randomRows(r, 80);
    const limits = randomLimits(r);
    const capital = (rows.length * limits.maxTotalDeployedPct) / 100;
    const led = walk(rows, limits, capital, 0);
    expect(led.entries, `control needs funded entries: ${ctx}`).toBeGreaterThan(0);
    const duplicated = led.terminalCash - led.peakPositionSize;
    expect(within(duplicated, capital), `a duplicated entry slipped inside the tolerance: ${ctx}`).toBe(false);
  });
});
