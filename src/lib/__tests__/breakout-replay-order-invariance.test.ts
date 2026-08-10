import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  chronological,
  driverSizingPlan,
} from "@/lib/breakout-driver-execution";
import { applySizingLimits, resolveSizingLimits } from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Order invariance: equivalent iteration orders must produce identical results.
 *
 * The determinism suite proves the same input twice gives the same output. That
 * leaves a whole class of bugs untouched — the ones where the *order* the
 * engine happens to walk its inputs leaks into the answer. Ranking with an
 * unstable tie break, accumulating into a Map and reading it back in insertion
 * order, or evaluating grid cells in a loop that shares state, all produce
 * results that are perfectly reproducible and still wrong: change the order the
 * database returned the rows, or the order the grid was requested in, and the
 * dashboard shows different allocations for the same history.
 *
 * So: shuffle everything that is supposed to be order-irrelevant — the input
 * array (the engine sorts it chronologically), the symbol enumeration, the grid
 * coordinates, and the order cells are computed in — and assert the trades,
 * per-symbol allocations, and P&L deltas come back byte-identical.
 *
 * Where order genuinely *is* meaningful — several signals on the same day
 * competing for the last slot under a binding cap — that is asserted
 * separately, with caps loosened so the tie break cannot matter.
 */

const FILE = "src/lib/__tests__/breakout-replay-order-invariance.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

/**
 * Cohort with one signal per calendar day, so date ordering is a total order
 * and any shuffle of the array is provably equivalent input.
 */
function distinctDayCohort(seed: number, size: number): SignalTrade[] {
  const r = rng(seed);
  const regimes = ["bull", "bear", "sideways"] as const;
  const symbols = 3 + Math.floor(r() * 7);
  return Array.from({ length: size }, (_, i) => ({
    symbol: `S${i % symbols}`,
    date: day(i),
    cohort: r() < 0.78 ? "confirmed" : "failed",
    direction: r() < 0.5 ? "up" : "down",
    side: "long",
    regime: regimes[Math.floor(r() * 3)],
    realisedVol20d: 0.006 + r() * 0.03,
    atrPct: 0.01 + r() * 0.03,
    quality: r(),
    penetrationAtr: r() * 2,
    volumeRatio: 0.8 + r() * 1.4,
    falseBreakoutRate: r() * 0.5,
    ageBars: 1 + Math.floor(r() * 6),
    pendingLatencyBars: Math.floor(r() * 3),
    entry: 100,
    exit: 100 + (r() - 0.42) * 10,
    exitReason: r() < 0.5 ? "target" : "stop",
    barsHeld: 2 + Math.floor(r() * 8),
    returnPct: (r() - 0.42) * 10,
    maxAdversePct: -r() * 5,
    maxFavourablePct: r() * 5,
  })) as SignalTrade[];
}

/** Fisher-Yates against the seeded generator, so a failing shuffle replays. */
function shuffle<T>(items: readonly T[], r: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const LIMITS = resolveSizingLimits({
  maxPositionSize: 1.5,
  maxConcurrentSignals: 4,
  maxTotalDeployedPct: 120,
});

/** Caps set so wide that nothing binds — order of arrival cannot matter. */
const LOOSE = resolveSizingLimits({
  maxPositionSize: 5,
  maxConcurrentSignals: 10_000,
  maxTotalDeployedPct: 100_000,
});

/**
 * Summation order over floats is not associative, so re-ordering the input can
 * move a score or a return by ~1e-15. That is arithmetic, not a logic
 * dependency, so every comparison rounds to 9 decimal places — far finer than
 * anything displayed, far coarser than float noise.
 */
const round9 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1e9) / 1e9 : n);
const deepRound = <T>(value: T): T => {
  if (typeof value === "number") return round9(value) as T;
  if (Array.isArray(value)) return value.map(deepRound) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepRound(v)]),
    ) as T;
  }
  return value;
};

/** Allocations keyed by symbol, sorted — insertion order deliberately discarded. */
const allocations = (trades: readonly SignalTrade[], risk: RiskLevel, gapWeight: number) =>
  [...driverSizingPlan(trades, { risk, gapWeight }).entries()]
    .map(([symbol, rec]) => [symbol, rec.action, round9(rec.sizeMultiplier), round9(rec.score)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

/** The P&L and cap deltas the dashboard reads. */
const summaryOf = (trades: readonly SignalTrade[], risk: RiskLevel, gapWeight: number, limits = LIMITS) => {
  const s = applyDriverSizing(trades, { risk, gapWeight, limits });
  const base = baselineExecution(trades, limits);
  return deepRound({
    taken: s.taken,
    signals: s.signals,
    avgSize: s.avgSize,
    deployedPct: s.deployedPct,
    breaches: s.limits.breaches,
    peakConcurrent: s.limits.peakConcurrent,
    peakPositionSize: s.limits.peakPositionSize,
    winRatePct: s.winRatePct,
    cumulativeReturnPct: s.cumulativeReturnPct,
    maxDrawdownPct: s.maxDrawdownPct,
    returnPerUnitPct: s.returnPerUnitPct,
    vsBaselinePp: s.cumulativeReturnPct - base.cumulativeReturnPct,
  });
};

/** The per-signal trade tape: what was actually executed, in replay order. */
const tape = (trades: readonly SignalTrade[], risk: RiskLevel, gapWeight: number, limits = LIMITS) => {
  const plan = driverSizingPlan(trades, { risk, gapWeight });
  // Same canonical order the engine replays in — same-day ties resolved.
  const confirmed = chronological(trades.filter((t) => t.cohort === "confirmed"));
  const rows = confirmed.map((t) => ({
    symbol: t.symbol,
    date: t.date,
    barsHeld: t.barsHeld,
    size: plan.get(t.symbol)?.sizeMultiplier ?? 1,
  }));
  return applySizingLimits(rows, limits).signals.map(
    (s) => `${s.date} ${s.symbol} ${s.size.toFixed(6)} [${[...s.clamped].sort().join("|")}]`,
  );
};

describe("replay is invariant to equivalent iteration orders", () => {
  it("shuffling the input array changes nothing (trades, allocations, P&L)", () => {
    for (let i = 0; i < 25; i++) {
      const r = rng(caseSeed(BASE_SEED, "input-order", i));
      const trades = distinctDayCohort(caseSeed(BASE_SEED, "cohort", i), 60 + Math.floor(r() * 90));
      const risk = RISK_LEVELS[Math.floor(r() * RISK_LEVELS.length)];
      const gapWeight = [0, 1, 2, 4, 6][Math.floor(r() * 5)];
      const ctx = `case ${i} ${risk}@${gapWeight} — ${REPRO}`;

      const expectedTape = tape(trades, risk, gapWeight);
      const expectedAlloc = allocations(trades, risk, gapWeight);
      const expectedSummary = summaryOf(trades, risk, gapWeight);

      for (let s = 0; s < 5; s++) {
        const shuffled = shuffle(trades, r);
        expect(tape(shuffled, risk, gapWeight), `trade tape moved under shuffle ${s}: ${ctx}`)
          .toEqual(expectedTape);
        expect(allocations(shuffled, risk, gapWeight), `allocations moved under shuffle ${s}: ${ctx}`)
          .toEqual(expectedAlloc);
        expect(summaryOf(shuffled, risk, gapWeight), `P&L deltas moved under shuffle ${s}: ${ctx}`)
          .toEqual(expectedSummary);
      }
    }
  });

  it("reversing the input is just another ordering", () => {
    const trades = distinctDayCohort(caseSeed(BASE_SEED, "reverse", 0), 140);
    for (const risk of RISK_LEVELS) {
      const ctx = `${risk} — ${REPRO}`;
      expect(tape([...trades].reverse(), risk, 2), `tape moved when reversed: ${ctx}`)
        .toEqual(tape(trades, risk, 2));
      expect(summaryOf([...trades].reverse(), risk, 2), `summary moved when reversed: ${ctx}`)
        .toEqual(summaryOf(trades, risk, 2));
    }
  });

  it("sorting the input by symbol instead of by date changes nothing", () => {
    // A very plausible real-world difference: rows arriving grouped per symbol
    // from one query and interleaved by date from another.
    const trades = distinctDayCohort(caseSeed(BASE_SEED, "bysymbol", 0), 150);
    const bySymbol = [...trades].sort(
      (a, b) => a.symbol.localeCompare(b.symbol) || a.date.localeCompare(b.date),
    );
    for (const risk of RISK_LEVELS) {
      expect(allocations(bySymbol, risk, 3), `allocations depend on grouping: ${risk} — ${REPRO}`)
        .toEqual(allocations(trades, risk, 3));
      expect(summaryOf(bySymbol, risk, 3), `summary depends on grouping: ${risk} — ${REPRO}`)
        .toEqual(summaryOf(trades, risk, 3));
    }
  });

  it("symbol naming order does not decide ranking ties", () => {
    // Rename symbols so alphabetical order is reversed while every metric is
    // untouched: rankings may reorder equal scores, but each symbol must keep
    // the action and size its own record earned.
    const trades = distinctDayCohort(caseSeed(BASE_SEED, "rename", 0), 120);
    const map = new Map(
      [...new Set(trades.map((t) => t.symbol))].map((s, i, all) => [s, `Z${all.length - i}`]),
    );
    const renamed = trades.map((t) => ({ ...t, symbol: map.get(t.symbol)! })) as SignalTrade[];

    for (const risk of RISK_LEVELS) {
      const before = new Map(allocations(trades, risk, 2).map(([s, ...rest]) => [map.get(s)!, rest]));
      const after = new Map(allocations(renamed, risk, 2).map(([s, ...rest]) => [s, rest]));
      expect([...after.keys()].sort(), `symbol set changed: ${risk} — ${REPRO}`).toEqual(
        [...before.keys()].sort(),
      );
      for (const [symbol, rest] of after) {
        expect(rest, `allocation follows the name, not the record (${symbol}): ${risk} — ${REPRO}`)
          .toEqual(before.get(symbol));
      }
    }
  });

  it("same-day signals may arrive in any order — including the drawdown path", () => {
    // The cohort is sorted on a total order (date, then symbol, holding period,
    // return, entry, side/direction/cohort/exit reason), so same-day signals
    // have exactly one canonical sequence however they arrived. That makes the
    // equity *path* — and therefore max drawdown — order-invariant too, so
    // nothing is excluded from this comparison any more.
    for (let i = 0; i < 15; i++) {
      const r = rng(caseSeed(BASE_SEED, "sameday", i));
      const base = distinctDayCohort(caseSeed(BASE_SEED, "sameday-cohort", i), 90);
      // Collapse onto a handful of days so most signals share a date.
      const clustered = base.map((t, k) => ({ ...t, date: day(k % 6) })) as SignalTrade[];
      const ctx = `same-day case ${i} — ${REPRO}`;

      const expected = summaryOf(clustered, "balanced", 2, LOOSE);
      const expectedTape = tape(clustered, "balanced", 2, LOOSE);
      for (let s = 0; s < 4; s++) {
        const shuffled = shuffle(clustered, r);
        expect(summaryOf(shuffled, "balanced", 2, LOOSE), `same-day order changed P&L: ${ctx}`)
          .toEqual(expected);
        expect(tape(shuffled, "balanced", 2, LOOSE), `same-day fills changed: ${ctx}`)
          .toEqual(expectedTape);
      }
    }
  });


  it("grid cells do not depend on the order they are computed in", () => {
    for (let i = 0; i < 6; i++) {
      const r = rng(caseSeed(BASE_SEED, "grid-order", i));
      const trades = distinctDayCohort(caseSeed(BASE_SEED, "grid-cohort", i), 120);
      const ctx = `grid case ${i} — ${REPRO}`;

      const forward = buildExecutionGrid(trades, { limits: LIMITS });
      const key = (c: { risk: RiskLevel; gapWeight: number }) => `${c.risk}@${c.gapWeight}`;
      const expected = new Map(forward.cells.map((c) => [key(c), deepRound(c)]));

      const risks = shuffle(RISK_LEVELS, r);
      const gapWeights = shuffle([...forward.gapWeights], r);
      const scrambled = buildExecutionGrid(trades, { risks, gapWeights, limits: LIMITS });

      expect(scrambled.cells.length, `cell count changed: ${ctx}`).toBe(forward.cells.length);
      for (const cell of scrambled.cells) {
        expect(deepRound(cell), `cell ${key(cell)} depends on grid traversal order: ${ctx}`)
          .toEqual(expected.get(key(cell)));
      }
      // The headline pick is a property of the cells, not of the walk — but
      // only its *value* can be pinned: when several cells tie on return, which
      // one is named "best" follows the order the caller asked for them in,
      // which is a caller choice rather than engine state.
      expect(round9(scrambled.best?.cumulativeReturnPct ?? 0), `best return moved: ${ctx}`).toBe(
        round9(forward.best?.cumulativeReturnPct ?? 0),
      );
      const ties = forward.cells.filter(
        (c) => round9(c.cumulativeReturnPct) === round9(forward.best?.cumulativeReturnPct ?? 0),
      ).length;
      if (ties === 1) {
        expect(scrambled.best && key(scrambled.best), `best cell moved: ${ctx}`).toBe(
          forward.best ? key(forward.best) : null,
        );
      }
      expect(deepRound(scrambled.baseline), `baseline moved: ${ctx}`).toEqual(
        deepRound(forward.baseline),
      );
    }
  });

  it("computing one cell at a time equals computing the whole grid", () => {
    // The grid is a batched path; interleaving single-cell calls in a random
    // order must not leave residue that changes a later cell.
    const r = rng(caseSeed(BASE_SEED, "interleave", 0));
    const trades = distinctDayCohort(caseSeed(BASE_SEED, "interleave-cohort", 0), 130);
    const grid = buildExecutionGrid(trades, { limits: LIMITS });

    const coords = shuffle(
      grid.cells.map((c) => ({ risk: c.risk, gapWeight: c.gapWeight })),
      r,
    );
    for (const coord of coords) {
      const standalone = applyDriverSizing(trades, { ...coord, limits: LIMITS });
      const batched = grid.cells.find(
        (c) => c.risk === coord.risk && c.gapWeight === coord.gapWeight,
      )!;
      const ctx = `${coord.risk}@${coord.gapWeight} — ${REPRO}`;
      expect(standalone.cumulativeReturnPct, `return differs from batched: ${ctx}`).toBe(
        batched.cumulativeReturnPct,
      );
      expect(standalone.limits, `caps differ from batched: ${ctx}`).toEqual(batched.limits);
      expect(standalone.taken, `taken differs from batched: ${ctx}`).toBe(batched.taken);
    }
  });

  it("the engine does not mutate or reorder the caller's array", () => {
    const trades = distinctDayCohort(caseSeed(BASE_SEED, "immutable", 0), 100);
    const before = JSON.stringify(trades);
    buildExecutionGrid(trades, { limits: LIMITS });
    applyDriverSizing(trades, { risk: "aggressive", gapWeight: 4, limits: LIMITS });
    baselineExecution(trades, LIMITS);
    driverSizingPlan(trades, { risk: "conservative", gapWeight: 0 });
    expect(JSON.stringify(trades), `caller's cohort was mutated — ${REPRO}`).toBe(before);
  });
});
