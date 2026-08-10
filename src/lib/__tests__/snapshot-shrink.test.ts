import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS } from "@/lib/breakout-driver-actions";
import { applyDriverSizing } from "@/lib/breakout-driver-execution";
import { applySizingLimits, resolveSizingLimits } from "@/lib/breakout-sizing-limits";
import { rng } from "./fuzz-seed";
import {
  cellKey,
  describeReplayCase,
  diffShapes,
  flattenShape,
  minimalMismatchFields,
  minimizeGridMismatch,
  minimizeSnapshotMismatch,
  mismatchSignature,
  replayCaseRepro,
  shrinkReplayCase,
  type CaseRenderer,
  type ReplayCase,
} from "./snapshot-shrink";

/**
 * Tests for the snapshot-mismatch minimizer itself.
 *
 * The minimizer only earns its place if it reliably lands on the *smallest*
 * case and reports the *root* field that moved. These tests plant known
 * regressions — a change that only bites above a cohort size, one that only
 * bites on an aggressive cell, one that only bites when a cap binds — and check
 * that shrinking converges on exactly that boundary without drifting onto some
 * other difference along the way.
 */

const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

/** Deterministic cohort from (seed, size) — the whole case is two integers. */
function buildCohort(seed: number, size: number): SignalTrade[] {
  const r = rng(seed);
  const regimes = ["bull", "bear", "sideways"] as const;
  return Array.from({ length: size }, (_, i) => ({
    symbol: `S${i % 6}`,
    date: day(Math.floor(i / 2)),
    cohort: r() < 0.78 ? "confirmed" : "failed",
    direction: "up",
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

const LIMITS = resolveSizingLimits({
  maxPositionSize: 1.5,
  maxConcurrentSignals: 4,
  maxTotalDeployedPct: 120,
});

const BIG: ReplayCase = { seed: 4242, size: 160, risk: "aggressive", gapWeight: 6, limits: LIMITS };

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The production summary shape, same fields the snapshot suite pins. */
const current: CaseRenderer = (c, trades) => {
  const s = applyDriverSizing(trades, { risk: c.risk, gapWeight: c.gapWeight, limits: c.limits });
  return {
    taken: s.taken,
    avgSize: r2(s.avgSize),
    deployedPct: r2(s.deployedPct),
    peakConcurrent: s.limits.peakConcurrent,
    caps: s.limits.breaches,
    cumulativeReturnPct: r2(s.cumulativeReturnPct),
    maxDrawdownPct: r2(s.maxDrawdownPct),
  };
};

describe("snapshot diffing", () => {
  it("flattens nested shapes to addressable paths", () => {
    expect(flattenShape({ a: 1, b: { c: 2 }, d: [3, 4] })).toEqual({
      a: 1,
      "b.c": 2,
      "d.0": 3,
      "d.1": 4,
    });
  });

  it("reports only fields that actually moved", () => {
    const diff = diffShapes({ a: 1, b: { c: 2 }, d: 3 }, { a: 1, b: { c: 9 }, d: 3 });
    expect(diff).toEqual([{ path: "b.c", expected: 2, actual: 9 }]);
    expect(mismatchSignature(diff)).toBe("b.c");
  });

  it("treats float noise below 1e-9 as equal, and NaN as equal to NaN", () => {
    expect(diffShapes({ a: 1, n: NaN }, { a: 1 + 1e-12, n: NaN })).toEqual([]);
    expect(diffShapes({ a: 1 }, { a: 1.001 })).toHaveLength(1);
  });

  it("notices added and removed fields, not just changed ones", () => {
    const diff = diffShapes({ a: 1 }, { a: 1, b: 2 });
    expect(diff.map((d) => d.path)).toEqual(["b"]);
  });

  it("collapses derived children into the root field that moved", () => {
    const diff = diffShapes({ caps: { budget: 0 }, x: 1 }, { caps: { budget: 3 }, x: 2 });
    expect(minimalMismatchFields(diff).map((d) => d.path).sort()).toEqual(["caps.budget", "x"]);
  });

  it("signature ignores magnitudes so shrinking tracks the same fields", () => {
    const a = diffShapes({ v: 10 }, { v: 11 });
    const b = diffShapes({ v: 1000 }, { v: 4 });
    expect(mismatchSignature(a)).toBe(mismatchSignature(b));
  });
});

describe("case shrinking candidates", () => {
  it("proposes smaller cohorts before simpler grid cells", () => {
    const candidates = shrinkReplayCase(BIG);
    expect(candidates[0].size).toBeLessThan(BIG.size);
    const firstGridChange = candidates.findIndex((c) => c.gapWeight !== BIG.gapWeight);
    const lastSizeChange = candidates.map((c) => c.size !== BIG.size).lastIndexOf(true);
    expect(firstGridChange).toBeGreaterThan(lastSizeChange);
  });

  it("never proposes a case that is not simpler", () => {
    for (const c of shrinkReplayCase(BIG)) {
      const simpler =
        c.size < BIG.size ||
        c.gapWeight < BIG.gapWeight ||
        RISK_LEVELS.indexOf(c.risk) < RISK_LEVELS.indexOf(BIG.risk) ||
        c.limits.maxPositionSize < BIG.limits.maxPositionSize ||
        c.limits.maxConcurrentSignals < BIG.limits.maxConcurrentSignals ||
        c.limits.maxTotalDeployedPct < BIG.limits.maxTotalDeployedPct;
      expect(simpler, `not simpler: ${replayCaseRepro(c)}`).toBe(true);
    }
    expect(shrinkReplayCase({ ...BIG, size: 1, gapWeight: 0, risk: RISK_LEVELS[0] }).length)
      .toBeLessThan(shrinkReplayCase(BIG).length);
  });

  it("respects a minimum cohort size", () => {
    for (const c of shrinkReplayCase(BIG, { minSize: 40 })) expect(c.size).toBeGreaterThanOrEqual(40);
  });
});

describe("minimizing a snapshot mismatch", () => {
  it("returns null when the renderers agree", () => {
    expect(minimizeSnapshotMismatch(BIG, buildCohort, current, current)).toBeNull();
  });

  it("shrinks the cohort to near the size where the regression starts", () => {
    // Planted regression: the position cap is ignored once the cohort is large.
    const regressed: CaseRenderer = (c, trades) =>
      current(c, trades.length >= 40 ? trades : trades, ) && c.size >= 40
        ? current({ ...c, limits: resolveSizingLimits({ ...c.limits, maxPositionSize: 99 }) }, trades)
        : current(c, trades);

    const found = minimizeSnapshotMismatch(BIG, buildCohort, regressed, current);
    expect(found).not.toBeNull();
    // It must land just above the threshold, not stay at 160.
    expect(found!.value.size).toBeGreaterThanOrEqual(40);
    expect(found!.value.size).toBeLessThan(BIG.size / 2);
    expect(found!.steps).toBeGreaterThan(0);
    expect(found!.diff.length).toBeGreaterThan(0);
  });

  it("shrinks the grid coordinate when the regression is cell-specific", () => {
    // Only aggressive cells are affected, and only above gap weight 0.
    const regressed: CaseRenderer = (c, trades) =>
      c.risk === "aggressive"
        ? current({ ...c, limits: resolveSizingLimits({ ...c.limits, maxConcurrentSignals: 2 }) }, trades)
        : current(c, trades);

    const found = minimizeSnapshotMismatch(BIG, buildCohort, regressed, current);
    expect(found).not.toBeNull();
    // Risk cannot shrink (the bug lives there) but the gap weight can.
    expect(found!.value.risk).toBe("aggressive");
    expect(found!.value.gapWeight).toBe(0);
    expect(found!.value.size).toBeLessThan(BIG.size);
  });

  it("keeps the caps that matter and drops the ones that do not", () => {
    // Regression only shows when the budget cap actually binds.
    const regressed: CaseRenderer = (c, trades) => {
      const rows = trades
        .filter((t) => t.cohort === "confirmed")
        .map((t) => ({ symbol: t.symbol, date: t.date, barsHeld: t.barsHeld, size: 1 }));
      const plan = applySizingLimits(rows, c.limits);
      const bound = plan.limits.breaches.budget > 0;
      return bound
        ? current({ ...c, limits: resolveSizingLimits({ ...c.limits, maxTotalDeployedPct: 999 }) }, trades)
        : current(c, trades);
    };

    const tight: ReplayCase = {
      ...BIG,
      limits: resolveSizingLimits({ maxPositionSize: 1.5, maxConcurrentSignals: 4, maxTotalDeployedPct: 30 }),
    };
    const found = minimizeSnapshotMismatch(tight, buildCohort, regressed, current);
    expect(found).not.toBeNull();
    // The budget cap must stay low enough to keep binding.
    expect(found!.value.limits.maxTotalDeployedPct).toBeLessThanOrEqual(30);
  });

  it("does not drift onto a different mismatch while shrinking", () => {
    // Two independent regressions: a big-cohort one and a small-cohort one that
    // moves a different field. Shrinking must not hop from the first to the
    // second and report the wrong minimum.
    const regressed: CaseRenderer = (c, trades) => {
      const base = current(c, trades);
      if (c.size >= 80) return { ...base, deployedPct: r2(base.deployedPct + 1) };
      if (c.size <= 10) return { ...base, taken: (base.taken as number) + 1 };
      return base;
    };

    const found = minimizeSnapshotMismatch(BIG, buildCohort, regressed, current);
    expect(found).not.toBeNull();
    expect(found!.signature).toBe("deployedPct");
    expect(found!.value.size).toBeGreaterThanOrEqual(80);
  });

  it("ignores candidates that throw rather than reporting a crash as the minimum", () => {
    const regressed: CaseRenderer = (c, trades) => {
      if (c.size < 50) throw new Error("generator blew up");
      const base = current(c, trades);
      return { ...base, cumulativeReturnPct: r2((base.cumulativeReturnPct as number) + 5) };
    };
    const found = minimizeSnapshotMismatch(BIG, buildCohort, regressed, current);
    expect(found).not.toBeNull();
    expect(found!.value.size).toBeGreaterThanOrEqual(50);
    expect(found!.signature).toBe("cumulativeReturnPct");
  });

  it("produces a readable, copy-pasteable report", () => {
    const regressed: CaseRenderer = (c, trades) => ({
      ...current(c, trades),
      cumulativeReturnPct: 1234.5,
    });
    const found = minimizeSnapshotMismatch(BIG, buildCohort, regressed, current)!;
    expect(found.report).toContain("Minimized counterexample");
    expect(found.report).toContain("cumulativeReturnPct");
    expect(found.report).toContain("repro: { seed: 4242");
    expect(describeReplayCase(found.value)).toContain("grid cell:");
  });

  it("stops within the step budget on a pathological case", () => {
    const regressed: CaseRenderer = (c, trades) => ({ ...current(c, trades), taken: -1 });
    const found = minimizeSnapshotMismatch(BIG, buildCohort, regressed, current, { maxSteps: 12 })!;
    expect(found.steps).toBeLessThanOrEqual(12);
  });
});

describe("pinned-value grid minimization", () => {
  const coords = RISK_LEVELS.flatMap((risk) => [0, 2, 4].map((gapWeight) => ({ risk, gapWeight })));
  const trades = buildCohort(99, 90);
  const pinnedOf = (risk: (typeof RISK_LEVELS)[number], gapWeight: number) =>
    current({ seed: 99, size: 90, risk, gapWeight, limits: LIMITS }, trades);
  const pinned = Object.fromEntries(coords.map((c) => [cellKey(c.risk, c.gapWeight), pinnedOf(c.risk, c.gapWeight)]));

  it("returns null when every pinned cell still matches", () => {
    expect(minimizeGridMismatch(pinned, pinnedOf, coords)).toBeNull();
  });

  it("reports the plainest affected cell and the root field", () => {
    const drifted = (risk: (typeof RISK_LEVELS)[number], gapWeight: number) => {
      const v = pinnedOf(risk, gapWeight);
      return risk === "conservative" || risk === "aggressive"
        ? { ...v, cumulativeReturnPct: r2((v.cumulativeReturnPct as number) + 2) }
        : v;
    };
    const found = minimizeGridMismatch(pinned, drifted, coords)!;
    expect(found.cell.risk).toBe("conservative");
    expect(found.cell.gapWeight).toBe(0);
    expect(found.diff.map((d) => d.path)).toEqual(["cumulativeReturnPct"]);
    expect(found.affectedCells).toBe(6);
    expect(found.report).toContain("also changed");
  });

  it("names a single-cell drift as such", () => {
    const drifted = (risk: (typeof RISK_LEVELS)[number], gapWeight: number) => {
      const v = pinnedOf(risk, gapWeight);
      return risk === "balanced" && gapWeight === 4 ? { ...v, peakConcurrent: 99 } : v;
    };
    const found = minimizeGridMismatch(pinned, drifted, coords)!;
    expect(found.affectedCells).toBe(1);
    expect(cellKey(found.cell.risk, found.cell.gapWeight)).toBe("balanced@4");
    expect(found.report).toContain("no other cell changed");
  });
});
