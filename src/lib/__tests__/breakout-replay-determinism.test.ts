import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  driverSizingPlan,
  findExecutionCell,
} from "@/lib/breakout-driver-execution";
import { applySizingLimits, resolveSizingLimits } from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Determinism: the same seed and cohort must replay to the same answer, twice.
 *
 * Everything else in this suite family — snapshots, fuzz invariants,
 * counterexample minimization, the perf budgets — assumes a replay is a pure
 * function of its inputs. If any stage picks up ambient state (a module-level
 * cache keyed too loosely, Map iteration over a mutated object, a tie broken by
 * insertion order, a Date or Math.random slipping into scoring), those suites
 * become flaky and a minimized counterexample stops reproducing.
 *
 * So each test runs the identical input through the pipeline twice and asserts
 * exact equality of the things a user would notice: which trades were taken and
 * at what size, the per-symbol allocations, and the P&L deltas versus baseline.
 * Interleaving and repetition are used deliberately to expose cross-run state.
 */

const FILE = "src/lib/__tests__/breakout-replay-determinism.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const day = (i: number) => {
  const d = new Date(Date.UTC(2024, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

/** A cohort generated purely from a seed — the same seed must rebuild it byte-for-byte. */
function cohort(seed: number, n: number): SignalTrade[] {
  const r = rng(seed);
  const regimes = ["bull", "bear", "sideways"] as const;
  const symbols = 4 + Math.floor(r() * 8);
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${i % symbols}`,
    date: day(Math.floor(i / 2)),
    cohort: r() < 0.75 ? "confirmed" : "failed",
    direction: r() < 0.5 ? "up" : "down",
    side: "long",
    regime: regimes[Math.floor(r() * 3)],
    realisedVol20d: 0.004 + r() * 0.04,
    atrPct: 0.008 + r() * 0.04,
    quality: r(),
    penetrationAtr: r() * 2.5,
    volumeRatio: 0.7 + r() * 1.5,
    falseBreakoutRate: r() * 0.6,
    ageBars: 1 + Math.floor(r() * 8),
    pendingLatencyBars: Math.floor(r() * 4),
    entry: 100,
    exit: 100 + (r() - 0.45) * 12,
    exitReason: r() < 0.5 ? "target" : "stop",
    barsHeld: 1 + Math.floor(r() * 12),
    returnPct: (r() - 0.45) * 12,
    maxAdversePct: -r() * 6,
    maxFavourablePct: r() * 6,
  })) as SignalTrade[];
}

const LIMITS = resolveSizingLimits({
  maxPositionSize: 1.6,
  maxConcurrentSignals: 6,
  maxTotalDeployedPct: 140,
});

/** The user-visible shape of a replay: trades taken, their sizes, the caps hit. */
const tradeShape = (trades: readonly SignalTrade[], sizes: readonly number[]) =>
  trades.map((t, i) => `${t.date} ${t.symbol} ${sizes[i].toFixed(10)} ${t.returnPct.toFixed(10)}`);

const allocationShape = (trades: readonly SignalTrade[], risk: RiskLevel, gapWeight: number) =>
  [...driverSizingPlan(trades, { risk, gapWeight })]
    .map(([symbol, p]) => `${symbol} ${p.action} ${p.sizeMultiplier.toFixed(10)} ${p.score.toFixed(10)}`)
    .sort();

describe("replay determinism", () => {
  it("rebuilds an identical cohort from the same seed", () => {
    const seed = caseSeed(BASE_SEED, "cohort", 1);
    expect(cohort(seed, 200), `cohort not reproducible — ${REPRO}`).toEqual(cohort(seed, 200));
    // Sanity: the generator is actually seed-sensitive, so equality above means
    // something. A constant generator would pass every test in this file.
    expect(cohort(seed, 200)).not.toEqual(cohort(seed + 1, 200));
  });

  it("produces identical trades and sizes when the same cohort is replayed twice", () => {
    for (let i = 0; i < 25; i++) {
      const trades = cohort(caseSeed(BASE_SEED, "sizes", i), 60 + i * 4);
      const confirmed = trades.filter((t) => t.cohort === "confirmed");
      const rows = confirmed.map((t) => ({
        symbol: t.symbol,
        date: t.date,
        barsHeld: t.barsHeld,
        size: 1,
      }));

      const a = applySizingLimits(rows, LIMITS);
      const b = applySizingLimits(rows, LIMITS);

      expect(b.signals, `sized signals differ on replay (case ${i}) — ${REPRO}`).toEqual(a.signals);
      expect(b.report, `limit report differs on replay (case ${i}) — ${REPRO}`).toEqual(a.report);
      expect(
        tradeShape(confirmed, b.signals.map((s) => s.size)),
        `taken trades differ on replay (case ${i}) — ${REPRO}`,
      ).toEqual(tradeShape(confirmed, a.signals.map((s) => s.size)));
    }
  });

  it("produces identical per-symbol allocations at every risk and gap weight", () => {
    const trades = cohort(caseSeed(BASE_SEED, "alloc", 0), 320);
    for (const risk of RISK_LEVELS) {
      for (const gapWeight of [0, 1, 2, 3, 4, 6]) {
        const first = allocationShape(trades, risk, gapWeight);
        const second = allocationShape(trades, risk, gapWeight);
        expect(second, `allocations differ for ${risk}@${gapWeight} — ${REPRO}`).toEqual(first);
        // Allocation is a pure function of the cohort, not of call order: a
        // stale ranking cache would show up as drift on the third call.
        expect(allocationShape(trades, risk, gapWeight)).toEqual(first);
      }
    }
  });

  it("produces identical P&L and deltas versus baseline across two full grids", () => {
    for (let i = 0; i < 8; i++) {
      const trades = cohort(caseSeed(BASE_SEED, "grid", i), 200 + i * 25);

      const a = buildExecutionGrid(trades, { limits: LIMITS });
      const b = buildExecutionGrid(trades, { limits: LIMITS });

      expect(b.baseline, `baseline differs on replay (case ${i}) — ${REPRO}`).toEqual(a.baseline);
      expect(b.cells, `grid cells differ on replay (case ${i}) — ${REPRO}`).toEqual(a.cells);
      expect(b.best, `best cell differs on replay (case ${i}) — ${REPRO}`).toEqual(a.best);
      expect(b.summary, `summary text differs on replay (case ${i}) — ${REPRO}`).toBe(a.summary);

      // The deltas specifically: these are what the compare and heatmap panels
      // render, so any instability here is visible to the user.
      for (const cell of a.cells) {
        const twin = findExecutionCell(b, cell.risk, cell.gapWeight);
        expect(twin, `missing cell ${cell.risk}@${cell.gapWeight} — ${REPRO}`).not.toBeNull();
        expect(twin!.vsBaseline, `deltas differ for ${cell.risk}@${cell.gapWeight} — ${REPRO}`).toEqual(
          cell.vsBaseline,
        );
        expect(twin!.cumulativeReturnPct).toBe(cell.cumulativeReturnPct);
        expect(twin!.maxDrawdownPct).toBe(cell.maxDrawdownPct);
        expect(twin!.limits).toEqual(cell.limits);
      }
    }
  });

  it("is unaffected by the order in which other cohorts were replayed", () => {
    // Cross-run contamination check: replay cohort A alone, then replay it again
    // with unrelated cohorts (and other settings) interleaved between the runs.
    const a = cohort(caseSeed(BASE_SEED, "order-a", 0), 180);
    const noise = [1, 2, 3].map((k) => cohort(caseSeed(BASE_SEED, "order-noise", k), 90 + k * 40));

    const clean = buildExecutionGrid(a, { limits: LIMITS });

    for (const other of noise) {
      buildExecutionGrid(other, { limits: LIMITS });
      applyDriverSizing(other, { risk: "aggressive", gapWeight: 6, limits: LIMITS });
      baselineExecution(other, LIMITS);
    }

    const contaminated = buildExecutionGrid(a, { limits: LIMITS });
    expect(contaminated.cells, `replay polluted by other cohorts — ${REPRO}`).toEqual(clean.cells);
    expect(contaminated.baseline, `baseline polluted by other cohorts — ${REPRO}`).toEqual(clean.baseline);
  });

  it("is stable across repeated runs of a single setting", () => {
    const trades = cohort(caseSeed(BASE_SEED, "repeat", 0), 240);
    const runs = Array.from({ length: 12 }, () =>
      applyDriverSizing(trades, { risk: "balanced", gapWeight: 3, limits: LIMITS }),
    );
    for (const run of runs.slice(1)) {
      expect(run, `drift across repeated identical runs — ${REPRO}`).toEqual(runs[0]);
    }
  });

  it("does not depend on the input array instance or on caller-side copies", () => {
    const trades = cohort(caseSeed(BASE_SEED, "copies", 0), 160);
    const copy = trades.map((t) => ({ ...t }));

    const fromOriginal = buildExecutionGrid(trades, { limits: LIMITS });
    const fromCopy = buildExecutionGrid(copy, { limits: LIMITS });
    expect(fromCopy.cells, `structurally equal cohorts replayed differently — ${REPRO}`).toEqual(
      fromOriginal.cells,
    );

    // And the replay must not mutate what it was given.
    expect(trades, `replay mutated the input cohort — ${REPRO}`).toEqual(copy);
  });
});
