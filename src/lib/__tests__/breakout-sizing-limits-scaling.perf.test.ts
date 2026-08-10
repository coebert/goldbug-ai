import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import { buildExecutionGrid } from "@/lib/breakout-driver-execution";
import { applySizingLimits, type LimitedPlan, type SizingLimits } from "@/lib/breakout-sizing-limits";
import { caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Scaling stress test for concurrency and grid size.
 *
 * The perf guard checks a fixed workload's wall time and the memory guard
 * checks retention; this one checks *shape*. Two things can rot silently as
 * the caps get exercised harder:
 *
 *  1. CPU time. The concurrency book is swept per signal. If a future change
 *     stops evicting expired positions (or rebuilds the timeline inside the
 *     loop), cost goes quadratic in cohort size and multiplicative in grid
 *     cells — invisible on the small fixtures the other suites use.
 *  2. Slot accounting. A "slot leak" is a position that stays in the open book
 *     after its hold window closed, or a skipped signal that still consumes a
 *     slot. Either one silently throttles trading, and `peakConcurrent` alone
 *     will not catch it because a leak makes that number look *compliant*.
 *
 * So every assertion here is either a scaling ratio or an occupancy invariant
 * recomputed independently from the returned plan — never a re-read of the
 * engine's own bookkeeping.
 *
 * There are no locks or async work in this pipeline, so "deadlock" means
 * non-termination: an eviction loop that never drains, or a book that fills
 * permanently so that raising the cap buys nothing. Both are asserted below.
 */

const FILE = "src/lib/__tests__/breakout-sizing-limits-scaling.perf.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const day = (i: number) => {
  const d = new Date(Date.UTC(2020, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

type Row = { symbol: string; date: string; barsHeld: number; size: number };

/**
 * A dense cohort: several signals share each date and hold for many bars, so
 * the concurrency book is genuinely contended rather than trivially empty.
 */
function cohort(n: number, label: string, index = 0): Row[] {
  const r = rng(caseSeed(BASE_SEED, label, index));
  const perDay = 3;
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${i % 60}`,
    date: day(Math.floor(i / perDay)),
    barsHeld: 1 + Math.floor(r() * 15),
    size: 0.2 + r() * 1.6,
  }));
}

function trades(n: number, label: string): SignalTrade[] {
  const r = rng(caseSeed(BASE_SEED, label, 0));
  const regimes = ["bull", "bear", "sideways"] as const;
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${i % 24}`,
    date: day(Math.floor(i / 3)),
    cohort: r() < 0.75 ? "confirmed" : "failed",
    direction: r() < 0.5 ? "up" : "down",
    side: "long",
    regime: regimes[i % regimes.length],
    realisedVol20d: 0.005 + r() * 0.03,
    atrPct: 0.01 + r() * 0.03,
    quality: r(),
    penetrationAtr: r() * 2,
    volumeRatio: 0.8 + r(),
    falseBreakoutRate: r() * 0.5,
    ageBars: 1 + Math.floor(r() * 5),
    pendingLatencyBars: Math.floor(r() * 3),
    entry: 100,
    exit: 100 + (r() - 0.45) * 10,
    exitReason: r() < 0.5 ? "target" : "stop",
    barsHeld: 1 + Math.floor(r() * 10),
    returnPct: (r() - 0.45) * 10,
    maxAdversePct: -r() * 5,
    maxFavourablePct: r() * 5,
  })) as SignalTrade[];
}

const LIMITS = (over: Partial<SizingLimits> = {}): SizingLimits => ({
  maxPositionSize: 1.5,
  maxConcurrentSignals: 8,
  maxTotalDeployedPct: 400,
  ...over,
});

// ---------------------------------------------------------------------------
// Independent slot accounting
// ---------------------------------------------------------------------------

type Occupancy = {
  /** Highest simultaneous open positions, recomputed from the plan. */
  peak: number;
  /** Slots still held after the last signal's hold window closed. */
  stranded: number;
  /** Signals refused for concurrency while the book had room. */
  falseRefusals: number;
  /** Signals admitted while the book was already full. */
  overAdmissions: number;
  taken: number;
};

/**
 * Rebuild the open book from the returned plan alone, using the same rank
 * arithmetic the engine documents ([rank, rank + barsHeld)). If the engine's
 * internal book ever diverges from what its own output implies, these counts
 * disagree with `report.peakConcurrent` and the caps.
 */
function occupancy(rows: readonly Row[], plan: LimitedPlan, cap: number): Occupancy {
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const rank = new Map(dates.map((d, i) => [d, i]));
  const open: number[] = []; // expiry ranks
  let peak = 0;
  let falseRefusals = 0;
  let overAdmissions = 0;
  let taken = 0;

  plan.signals.forEach((s, i) => {
    const r = rank.get(s.date) ?? 0;
    for (let j = open.length - 1; j >= 0; j--) if (open[j] <= r) open.splice(j, 1);
    const refusedForConcurrency = s.size === 0 && s.clamped.includes("concurrency");
    if (refusedForConcurrency && open.length < cap) falseRefusals++;
    if (s.size > 0) {
      if (open.length >= cap) overAdmissions++;
      taken++;
      open.push(r + Math.max(1, rows[i].barsHeld));
      if (open.length > peak) peak = open.length;
    }
  });

  const lastRank = dates.length - 1;
  const stranded = open.filter((until) => until <= lastRank).length;
  return { peak, stranded, falseRefusals, overAdmissions, taken };
}

/** Median of repeated timings — resistant to a single GC pause. */
function timeMs(runs: number, fn: () => unknown): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe("sizing-limits scaling stress", () => {
  it("stays sub-quadratic as cohort size grows 16x", () => {
    // Warm the JIT so the smallest size is not paying compilation.
    const warm = cohort(2_000, "warm");
    for (let i = 0; i < 3; i++) applySizingLimits(warm, LIMITS());

    const small = cohort(2_000, "scale", 1);
    const large = cohort(32_000, "scale", 2);
    const tSmall = Math.max(timeMs(5, () => applySizingLimits(small, LIMITS())), 0.05);
    const tLarge = timeMs(5, () => applySizingLimits(large, LIMITS()));
    const ratio = tLarge / tSmall;

    // Linear would be 16x. Quadratic would be 256x. 64x is a wide corridor
    // that still fails a genuine complexity regression.
    expect(ratio, `16x input took ${ratio.toFixed(1)}x the time — ${REPRO}`).toBeLessThan(64);
  });

  it("cost is flat in the concurrency cap, not proportional to it", () => {
    // A per-signal full scan of the book would make a 64-slot cap ~8x the
    // work of an 8-slot one. Eviction-on-expiry keeps it near flat.
    const rows = cohort(20_000, "cap-cost");
    const tight = Math.max(timeMs(5, () => applySizingLimits(rows, LIMITS({ maxConcurrentSignals: 4 }))), 0.05);
    const wide = timeMs(5, () => applySizingLimits(rows, LIMITS({ maxConcurrentSignals: 256 })));
    const ratio = wide / tight;
    expect(ratio, `64x the cap cost ${ratio.toFixed(1)}x the time — ${REPRO}`).toBeLessThan(12);
  });

  it("never leaks or over-issues slots at any concurrency level", () => {
    const rows = cohort(6_000, "slots");
    for (const cap of [1, 2, 4, 8, 16, 32, 64, 128]) {
      const limits = LIMITS({ maxConcurrentSignals: cap, maxTotalDeployedPct: 100_000 });
      const plan = applySizingLimits(rows, limits);
      const occ = occupancy(rows, plan, cap);
      const ctx = `cap=${cap} — ${REPRO}`;

      expect(occ.overAdmissions, `admitted past a full book: ${ctx}`).toBe(0);
      expect(occ.falseRefusals, `refused with slots free (leak): ${ctx}`).toBe(0);
      expect(occ.stranded, `positions never released (leak): ${ctx}`).toBe(0);
      expect(occ.peak, `peak occupancy exceeded the cap: ${ctx}`).toBeLessThanOrEqual(cap);
      // The engine's own bookkeeping must agree with the recomputation.
      expect(plan.report.peakConcurrent, `report disagrees with plan: ${ctx}`).toBe(occ.peak);
    }
  });

  it("raising the cap monotonically admits more signals (no permanent stall)", () => {
    // The deadlock analogue: a book that fills and never drains would keep
    // `taken` pinned no matter how many slots exist.
    const rows = cohort(6_000, "monotone");
    let previous = -1;
    for (const cap of [1, 2, 4, 8, 16, 32, 64]) {
      const plan = applySizingLimits(rows, LIMITS({ maxConcurrentSignals: cap, maxTotalDeployedPct: 100_000 }));
      const taken = plan.signals.filter((s) => s.size > 0).length;
      expect(taken, `cap ${cap} admitted fewer than a tighter cap — ${REPRO}`).toBeGreaterThanOrEqual(previous);
      previous = taken;
    }
    // And a very wide cap must stop refusing entirely.
    const wide = applySizingLimits(rows, LIMITS({ maxConcurrentSignals: 100_000, maxTotalDeployedPct: 100_000 }));
    expect(wide.report.breaches.concurrency, `still refusing with an unbounded cap — ${REPRO}`).toBe(0);
  });

  it("saturating hold windows still terminate and release", () => {
    // Every position holds far longer than the whole timeline: the book fills
    // immediately and can only be freed at the end. A non-draining eviction
    // loop hangs here rather than returning.
    const rows = cohort(4_000, "saturate").map((r) => ({ ...r, barsHeld: 10_000 }));
    const cap = 5;
    const plan = applySizingLimits(rows, LIMITS({ maxConcurrentSignals: cap, maxTotalDeployedPct: 100_000 }));
    const taken = plan.signals.filter((s) => s.size > 0).length;
    expect(taken, `expected exactly the cap to be filled — ${REPRO}`).toBe(cap);
    expect(plan.report.peakConcurrent).toBe(cap);
    expect(plan.report.breaches.concurrency, `refusals should be everything else — ${REPRO}`).toBe(
      rows.length - cap,
    );
  });

  it("grid cost scales with cell count, not worse", () => {
    const sample = trades(1_200, "grid");
    const risks = [...RISK_LEVELS] as RiskLevel[];
    const oneRow = Math.max(
      timeMs(3, () => buildExecutionGrid(sample, { risks: [risks[0]], gapWeights: [0, 1] })),
      0.05,
    );
    const cells = risks.length * 6;
    const full = timeMs(3, () => buildExecutionGrid(sample, { risks, gapWeights: [0, 1, 2, 3, 4, 6] }));
    const perCellRatio = full / oneRow / (cells / 2);
    // Each cell replays the same cohort, so per-cell cost should be roughly
    // constant. 4x per-cell drift means shared work became per-cell work.
    expect(perCellRatio, `per-cell cost drifted ${perCellRatio.toFixed(1)}x — ${REPRO}`).toBeLessThan(4);
  });

  it("every grid cell respects the shared caps as the grid grows", () => {
    const sample = trades(1_500, "grid-caps");
    const limits = LIMITS({ maxConcurrentSignals: 6, maxPositionSize: 1.25, maxTotalDeployedPct: 250 });
    const grid = buildExecutionGrid(sample, {
      risks: [...RISK_LEVELS],
      gapWeights: [0, 1, 2, 3, 4, 6],
      limits,
    });
    expect(grid.cells.length).toBe(RISK_LEVELS.length * 6);
    for (const cell of grid.cells) {
      const ctx = `${cell.risk} @ ${cell.gapWeight}× — ${REPRO}`;
      expect(cell.limits.peakConcurrent, `peak concurrency over cap: ${ctx}`).toBeLessThanOrEqual(
        limits.maxConcurrentSignals,
      );
      expect(cell.limits.peakPositionSize, `position over ceiling: ${ctx}`).toBeLessThanOrEqual(
        limits.maxPositionSize + 1e-9,
      );
      expect(cell.deployedPct, `deployment over budget: ${ctx}`).toBeLessThanOrEqual(
        limits.maxTotalDeployedPct + 1e-6,
      );
      expect(Number.isFinite(cell.cumulativeReturnPct), `non-finite return: ${ctx}`).toBe(true);
    }
    expect(grid.baseline.limits.peakConcurrent).toBeLessThanOrEqual(limits.maxConcurrentSignals);
  });
});
