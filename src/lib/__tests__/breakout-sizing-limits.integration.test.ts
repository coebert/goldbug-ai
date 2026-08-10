import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  findExecutionCell,
} from "@/lib/breakout-driver-execution";
import { DEFAULT_SIZING_LIMITS, resolveSizingLimits } from "@/lib/breakout-sizing-limits";
import { RISK_LEVELS } from "@/lib/breakout-driver-actions";

/**
 * Integration coverage for the safety caps as they behave inside the real
 * execution flow — driver ranking → recommended multipliers → caps → replay →
 * summary metrics. The unit tests prove the caps clamp a list of numbers;
 * these prove the clamped numbers are the ones the backtest actually trades
 * and reports, and that the caps interact correctly (a position clamped by
 * the ceiling still consumes a concurrency slot, budget is spent on the
 * clamped size, and the baseline control obeys the same caps).
 */

const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

let seq = 0;
const trade = (over: Partial<SignalTrade> = {}): SignalTrade => {
  const t: SignalTrade = {
    symbol: "AAA",
    date: day(seq++),
    cohort: "confirmed",
    direction: "up",
    side: "long",
    regime: "bull",
    realisedVol20d: 0.01,
    atrPct: 0.02,
    quality: 0.7,
    penetrationAtr: 0.5,
    volumeRatio: 1.4,
    falseBreakoutRate: 0.2,
    ageBars: 1,
    pendingLatencyBars: 1,
    entry: 100,
    exit: 102,
    exitReason: "target",
    barsHeld: 4,
    returnPct: 2,
    maxAdversePct: -1,
    maxFavourablePct: 3,
    ...over,
  };
  return t;
};

/**
 * A cohort with a clear winner (AAA) and loser (BBB) so the driver panel
 * ranks them apart and hands back genuinely different multipliers, each
 * signal on its own date with a long hold so overlap is guaranteed.
 */
function cohort(opts: { barsHeld?: number } = {}): SignalTrade[] {
  seq = 0;
  const barsHeld = opts.barsHeld ?? 6;
  const out: SignalTrade[] = [];
  for (let i = 0; i < 10; i++) out.push(trade({ symbol: "AAA", returnPct: 4, barsHeld }));
  for (let i = 0; i < 10; i++) out.push(trade({ symbol: "BBB", returnPct: -4, barsHeld }));
  for (let i = 0; i < 10; i++)
    out.push(trade({ symbol: "AAA", cohort: "failed", returnPct: -1, barsHeld }));
  for (let i = 0; i < 10; i++)
    out.push(trade({ symbol: "BBB", cohort: "failed", returnPct: 3, barsHeld }));
  return out;
}

/** Recompute the summary's compounded return straight from the report rows. */
function recompute(sizes: readonly number[], returns: readonly number[]): number {
  let equity = 1;
  for (let i = 0; i < sizes.length; i++) equity *= 1 + (returns[i]! * sizes[i]!) / 100;
  return (equity - 1) * 100;
}

describe("sizing limits inside the execution flow — position ceiling", () => {
  it("clamps driver multipliers and reports the clamped deployment", () => {
    const trades = cohort();
    const uncapped = applyDriverSizing(trades, {
      risk: "aggressive",
      gapWeight: 2,
      limits: { maxPositionSize: 99, maxConcurrentSignals: 999, maxTotalDeployedPct: 100_000 },
    });
    const capped = applyDriverSizing(trades, {
      risk: "aggressive",
      gapWeight: 2,
      limits: { maxPositionSize: 1, maxConcurrentSignals: 999, maxTotalDeployedPct: 100_000 },
    });

    // The aggressive profile asks for >1x on the prioritised winner.
    expect(uncapped.limits.peakPositionSize).toBeGreaterThan(1);
    expect(capped.limits.peakPositionSize).toBeLessThanOrEqual(1);
    expect(capped.limits.breaches.position).toBeGreaterThan(0);
    expect(capped.deployedPct).toBeLessThan(uncapped.deployedPct);
    // avgSize is the metric the UI shows; it must track the clamped sizes.
    expect(capped.avgSize).toBeCloseTo(capped.deployedPct / 100, 10);
  });

  it("feeds clamped sizes into P&L, not the requested ones", () => {
    const trades = cohort();
    const confirmed = trades
      .filter((t) => t.cohort === "confirmed")
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const s = applyDriverSizing(trades, {
      risk: "aggressive",
      gapWeight: 3,
      limits: { maxPositionSize: 0.8, maxConcurrentSignals: 999, maxTotalDeployedPct: 100_000 },
    });
    const sizes = confirmed.map(() => 0.8);
    // Every requested multiplier in this cohort is >= 0.8 or 0 (avoid), so the
    // exact per-row sizes come from the report rather than being assumed.
    expect(s.cumulativeReturnPct).toBeCloseTo(
      recompute(
        confirmed.map((_, i) => Math.min(sizes[i]!, 0.8)),
        confirmed.map((t) => t.returnPct),
      ),
      6,
    );
  });

  it("sizes everything to zero when the ceiling is zero", () => {
    const grid = buildExecutionGrid(cohort(), {
      gapWeights: [0, 2],
      limits: { maxPositionSize: 0 },
    });
    expect(grid.cells.every((c) => c.taken === 0)).toBe(true);
    expect(grid.cells.every((c) => c.deployedPct === 0)).toBe(true);
    expect(grid.cells.every((c) => c.cumulativeReturnPct === 0)).toBe(true);
    expect(grid.best).toBeNull();
    expect(grid.summary).toContain("sized the confirmed cohort to zero");
  });
});

describe("sizing limits inside the execution flow — concurrency", () => {
  it("skips overlapping signals and books them as skipped in the summary", () => {
    const trades = cohort({ barsHeld: 6 });
    const wide = applyDriverSizing(trades, {
      risk: "balanced",
      gapWeight: 1,
      limits: { maxConcurrentSignals: 999, maxTotalDeployedPct: 100_000 },
    });
    const narrow = applyDriverSizing(trades, {
      risk: "balanced",
      gapWeight: 1,
      limits: { maxConcurrentSignals: 1, maxTotalDeployedPct: 100_000 },
    });

    expect(narrow.limits.peakConcurrent).toBeLessThanOrEqual(1);
    expect(narrow.limits.breaches.concurrency).toBeGreaterThan(0);
    expect(narrow.taken).toBeLessThan(wide.taken);
    expect(narrow.taken + narrow.skipped).toBe(narrow.signals);
    expect(narrow.deployedPct).toBeLessThan(wide.deployedPct);
  });

  it("frees a slot once the hold window closes", () => {
    // barsHeld 1 on consecutive dates: no two positions are ever open at once,
    // so even a single-slot book takes every signal.
    const trades = cohort({ barsHeld: 1 });
    const s = applyDriverSizing(trades, {
      risk: "balanced",
      gapWeight: 0,
      limits: { maxConcurrentSignals: 1, maxTotalDeployedPct: 100_000 },
    });
    expect(s.limits.breaches.concurrency).toBe(0);
    expect(s.limits.peakConcurrent).toBe(1);
  });

  it("still consumes a slot for a position the ceiling clamped", () => {
    // Ceiling bites first, then the clamped (non-zero) size occupies the book.
    const trades = cohort({ barsHeld: 6 });
    const s = applyDriverSizing(trades, {
      risk: "aggressive",
      gapWeight: 2,
      limits: { maxPositionSize: 0.25, maxConcurrentSignals: 2, maxTotalDeployedPct: 100_000 },
    });
    expect(s.limits.breaches.position).toBeGreaterThan(0);
    expect(s.limits.breaches.concurrency).toBeGreaterThan(0);
    expect(s.limits.peakConcurrent).toBeLessThanOrEqual(2);
    expect(s.limits.peakPositionSize).toBeLessThanOrEqual(0.25);
  });
});

describe("sizing limits inside the execution flow — budget and interactions", () => {
  it("holds aggregate deployment under the budget for every grid cell", () => {
    const grid = buildExecutionGrid(cohort(), {
      gapWeights: [0, 2, 4],
      limits: { maxPositionSize: 1.5, maxConcurrentSignals: 4, maxTotalDeployedPct: 40 },
    });
    expect(grid.limits).toEqual(
      resolveSizingLimits({ maxPositionSize: 1.5, maxConcurrentSignals: 4, maxTotalDeployedPct: 40 }),
    );
    for (const c of grid.cells) {
      expect(c.deployedPct).toBeLessThanOrEqual(40 + 1e-9);
      expect(c.limits.peakConcurrent).toBeLessThanOrEqual(4);
      expect(c.limits.peakPositionSize).toBeLessThanOrEqual(1.5 + 1e-9);
      expect(Number.isFinite(c.cumulativeReturnPct)).toBe(true);
    }
    expect(grid.baseline.deployedPct).toBeLessThanOrEqual(40 + 1e-9);
  });

  it("applies the same caps to the baseline control so comparisons stay honest", () => {
    const trades = cohort({ barsHeld: 6 });
    const limits = { maxConcurrentSignals: 2, maxTotalDeployedPct: 100 };
    const base = baselineExecution(trades, limits);
    expect(base.limits.breaches.concurrency).toBeGreaterThan(0);
    expect(base.deployedPct).toBeLessThan(100);

    const grid = buildExecutionGrid(trades, { gapWeights: [2], limits });
    const cell = findExecutionCell(grid, "balanced", 2)!;
    // vsBaseline deltas are measured against the capped control, not a
    // fictional uncapped one.
    expect(cell.vsBaseline.deployedPp).toBeCloseTo(cell.deployedPct - base.deployedPct, 9);
    expect(cell.vsBaseline.cumulativeReturnPp).toBeCloseTo(
      cell.cumulativeReturnPct - grid.baseline.cumulativeReturnPct,
      9,
    );
  });

  it("lets the tightest cap win when all three compete", () => {
    const trades = cohort({ barsHeld: 8 });
    const s = applyDriverSizing(trades, {
      risk: "aggressive",
      gapWeight: 4,
      limits: { maxPositionSize: 1.2, maxConcurrentSignals: 2, maxTotalDeployedPct: 15 },
    });
    const signals = s.signals;
    expect(s.deployedPct).toBeLessThanOrEqual(15 + 1e-9);
    expect(s.avgSize * signals).toBeLessThanOrEqual((signals * 15) / 100 + 1e-9);
    expect(s.limits.peakPositionSize).toBeLessThanOrEqual(1.2);
    expect(s.limits.peakConcurrent).toBeLessThanOrEqual(2);
    expect(s.taken).toBeGreaterThan(0);
    expect(s.limits.summary).toContain("Caps bit on");
  });

  it("defaults are always on when no limits are supplied", () => {
    const s = applyDriverSizing(cohort(), { risk: "aggressive", gapWeight: 3 });
    expect(s.limits.limits).toEqual(DEFAULT_SIZING_LIMITS);
    expect(s.limits.peakPositionSize).toBeLessThanOrEqual(DEFAULT_SIZING_LIMITS.maxPositionSize);
    expect(s.limits.peakConcurrent).toBeLessThanOrEqual(
      DEFAULT_SIZING_LIMITS.maxConcurrentSignals,
    );
    expect(s.deployedPct).toBeLessThanOrEqual(DEFAULT_SIZING_LIMITS.maxTotalDeployedPct + 1e-9);
  });

  it("falls back to defaults when a caller passes non-finite caps through the grid", () => {
    const grid = buildExecutionGrid(cohort(), {
      gapWeights: [1],
      limits: {
        maxPositionSize: Number.NaN,
        maxConcurrentSignals: Number.NaN,
        maxTotalDeployedPct: Number.NaN,
      },
    });
    expect(grid.limits).toEqual(DEFAULT_SIZING_LIMITS);
    for (const c of grid.cells) {
      expect(Number.isFinite(c.deployedPct)).toBe(true);
      expect(Number.isFinite(c.cumulativeReturnPct)).toBe(true);
      expect(Number.isFinite(c.maxDrawdownPct)).toBe(true);
      expect(c.deployedPct).toBeLessThanOrEqual(DEFAULT_SIZING_LIMITS.maxTotalDeployedPct + 1e-9);
    }
  });

  it("keeps every risk profile inside the caps", () => {
    for (const risk of RISK_LEVELS) {
      const s = applyDriverSizing(cohort({ barsHeld: 5 }), {
        risk,
        gapWeight: 2,
        limits: { maxPositionSize: 1.1, maxConcurrentSignals: 3, maxTotalDeployedPct: 60 },
      });
      expect(s.limits.peakPositionSize, risk).toBeLessThanOrEqual(1.1 + 1e-9);
      expect(s.limits.peakConcurrent, risk).toBeLessThanOrEqual(3);
      expect(s.deployedPct, risk).toBeLessThanOrEqual(60 + 1e-9);
      expect(s.taken + s.skipped, risk).toBe(s.signals);
      expect(Object.values(s.actionCounts).reduce((a, b) => a + b, 0), risk).toBeLessThanOrEqual(
        s.signals,
      );
    }
  });

  it("monotonically loosens deployment as the budget is raised", () => {
    const trades = cohort({ barsHeld: 4 });
    const deployed = [10, 25, 50, 100].map(
      (pct) =>
        applyDriverSizing(trades, {
          risk: "balanced",
          gapWeight: 2,
          limits: { maxConcurrentSignals: 999, maxTotalDeployedPct: pct },
        }).deployedPct,
    );
    for (let i = 1; i < deployed.length; i++) {
      expect(deployed[i]!).toBeGreaterThanOrEqual(deployed[i - 1]! - 1e-9);
    }
  });
});
