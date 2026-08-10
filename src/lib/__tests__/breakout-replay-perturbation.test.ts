import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  driverSizingPlan,
} from "@/lib/breakout-driver-execution";
import { applySizingLimits, resolveSizingLimits } from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Numerical stability: a replay must not be balanced on a knife edge.
 *
 * Every float that feeds the engine arrives with noise already in it — a price
 * rounded to the tick, an ATR recomputed from a slightly different window, a
 * return that came back with one more decimal from the broker than from the
 * cache. If a nudge of one part in a trillion moves the P&L or flips a fill,
 * the numbers on the dashboard are not measuring the strategy, they are
 * measuring rounding.
 *
 * These tests re-run the same replay with the inputs perturbed by a relative
 * epsilon and assert three things:
 *
 *   1. Determinism survives — the same perturbation applied twice gives
 *      byte-identical output, so nothing is reading uninitialised or ambient
 *      state under the cover of "float noise".
 *   2. Continuity — while the *discrete* decisions hold (same actions, same
 *      fills), the trades and P&L deltas stay inside a tight tolerance that
 *      scales with the perturbation, not with the cohort size.
 *   3. Invariants hold unconditionally — caps, non-negative sizes and budget
 *      never break, whatever the perturbation does to the decisions.
 *
 * Discrete flips are expected and legitimate: a symbol whose score sits exactly
 * on the `trade`/`downsize` boundary can and should fall either way. What is
 * not legitimate is a flip being *common* at 1e-12, which would mean the
 * rankings are separated by less than their own numerical error.
 */

const FILE = "src/lib/__tests__/breakout-replay-perturbation.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

function cohort(seed: number, size: number): SignalTrade[] {
  const r = rng(seed);
  const regimes = ["bull", "bear", "sideways"] as const;
  const symbols = 4 + Math.floor(r() * 6);
  return Array.from({ length: size }, (_, i) => ({
    symbol: `S${i % symbols}`,
    date: day(Math.floor(i / 2)),
    cohort: r() < 0.78 ? "confirmed" : "failed",
    direction: r() < 0.5 ? "up" : "down",
    side: "long",
    regime: regimes[Math.floor(r() * 3)],
    realisedVol20d: 0.006 + r() * 0.03,
    atrPct: 0.01 + r() * 0.03,
    quality: 0.05 + r() * 0.9,
    penetrationAtr: 0.1 + r() * 2,
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

/** Continuous fields only: bar counts and dates are discrete and stay put. */
const FLOAT_FIELDS = [
  "realisedVol20d",
  "atrPct",
  "quality",
  "penetrationAtr",
  "volumeRatio",
  "falseBreakoutRate",
  "entry",
  "exit",
  "returnPct",
  "maxAdversePct",
  "maxFavourablePct",
] as const;

/**
 * Nudge every float by up to ±`eps` *relative* to its own magnitude, so the
 * perturbation is scale-free: a 0.02 ATR and a 100.0 entry price both move by
 * the same number of significant digits.
 */
function perturb(trades: readonly SignalTrade[], eps: number, r: () => number): SignalTrade[] {
  return trades.map((t) => {
    const next: Record<string, unknown> = { ...t };
    for (const field of FLOAT_FIELDS) {
      const v = t[field] as number;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      next[field] = v * (1 + (r() * 2 - 1) * eps);
    }
    return next as SignalTrade;
  });
}

const LIMITS = resolveSizingLimits({
  maxPositionSize: 1.5,
  maxConcurrentSignals: 4,
  maxTotalDeployedPct: 120,
});

type Alloc = { symbol: string; action: string; size: number };

const allocations = (trades: readonly SignalTrade[], risk: RiskLevel, gapWeight: number): Alloc[] =>
  [...driverSizingPlan(trades, { risk, gapWeight }).entries()]
    .map(([symbol, rec]) => ({ symbol, action: rec.action, size: rec.sizeMultiplier }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

const sameDecisions = (a: readonly Alloc[], b: readonly Alloc[]) =>
  a.length === b.length &&
  a.every((x, i) => x.symbol === b[i].symbol && x.action === b[i].action && Math.abs(x.size - b[i].size) < 1e-12);

/** The executed tape: which signal got funded, and for how much. */
function fills(trades: readonly SignalTrade[], risk: RiskLevel, gapWeight: number) {
  const plan = driverSizingPlan(trades, { risk, gapWeight });
  const confirmed = [...trades]
    .filter((t) => t.cohort === "confirmed")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rows = confirmed.map((t) => ({
    symbol: t.symbol,
    date: t.date,
    barsHeld: t.barsHeld,
    size: plan.get(t.symbol)?.sizeMultiplier ?? 1,
  }));
  const limited = applySizingLimits(rows, LIMITS);
  return {
    rows,
    signals: limited.signals,
    report: limited.report,
    tape: limited.signals.map((s) => ({
      key: `${s.date} ${s.symbol}`,
      size: s.size,
      clamped: [...s.clamped].sort().join("|"),
    })),
  };
}

const summaryOf = (trades: readonly SignalTrade[], risk: RiskLevel, gapWeight: number) => {
  const s = applyDriverSizing(trades, { risk, gapWeight, limits: LIMITS });
  const base = baselineExecution(trades, LIMITS);
  return {
    taken: s.taken,
    avgSize: s.avgSize,
    deployedPct: s.deployedPct,
    cumulativeReturnPct: s.cumulativeReturnPct,
    maxDrawdownPct: s.maxDrawdownPct,
    returnPerUnitPct: s.returnPerUnitPct,
    winRatePct: s.winRatePct,
    vsBaselinePp: s.cumulativeReturnPct - base.cumulativeReturnPct,
    peakConcurrent: s.limits.peakConcurrent,
    peakPositionSize: s.limits.peakPositionSize,
  };
};

/** Caps and solvency, asserted no matter what the perturbation did. */
function assertInvariants(trades: readonly SignalTrade[], risk: RiskLevel, gapWeight: number, ctx: string) {
  const { rows, signals, report } = fills(trades, risk, gapWeight);
  const capital = (rows.length * LIMITS.maxTotalDeployedPct) / 100;
  let spent = 0;
  signals.forEach((s, i) => {
    expect(Number.isFinite(s.size), `non-finite size at ${i}: ${ctx}`).toBe(true);
    expect(s.size, `negative size at ${i}: ${ctx}`).toBeGreaterThanOrEqual(0);
    expect(s.size, `over position cap at ${i}: ${ctx}`).toBeLessThanOrEqual(LIMITS.maxPositionSize + 1e-9);
    spent += s.size;
  });
  expect(spent, `over budget: ${ctx}`).toBeLessThanOrEqual(capital + 1e-6);
  expect(report.peakConcurrent, `over concurrency cap: ${ctx}`).toBeLessThanOrEqual(
    LIMITS.maxConcurrentSignals,
  );
}

/** Tolerance for a percentage-valued metric under a relative perturbation. */
const tol = (eps: number, magnitude: number) => Math.max(1e-9, eps * Math.max(1, Math.abs(magnitude)) * 200);

describe("replay stability under perturbed floating inputs", () => {
  it("an identical perturbation replays identically (no ambient state)", () => {
    for (let i = 0; i < 12; i++) {
      const trades = cohort(caseSeed(BASE_SEED, "cohort", i), 120);
      const risk = RISK_LEVELS[i % RISK_LEVELS.length];
      const ctx = `case ${i} ${risk} — ${REPRO}`;

      // Same perturbation seed both times: the nudged cohort is identical, so
      // the replay must be too, right down to the last bit.
      const a = perturb(trades, 1e-9, rng(caseSeed(BASE_SEED, "nudge", i)));
      const b = perturb(trades, 1e-9, rng(caseSeed(BASE_SEED, "nudge", i)));
      expect(JSON.stringify(b), `perturbation is not reproducible: ${ctx}`).toBe(JSON.stringify(a));

      expect(summaryOf(b, risk, 2), `summary differs on identical input: ${ctx}`).toEqual(
        summaryOf(a, risk, 2),
      );
      expect(fills(b, risk, 2).tape, `tape differs on identical input: ${ctx}`).toEqual(
        fills(a, risk, 2).tape,
      );
    }
  });

  it("1e-12 nudges leave the trade tape and P&L deltas within tolerance", () => {
    const eps = 1e-12;
    let flipped = 0;
    let compared = 0;

    for (let i = 0; i < 30; i++) {
      const r = rng(caseSeed(BASE_SEED, "tiny", i));
      const trades = cohort(caseSeed(BASE_SEED, "tiny-cohort", i), 90 + Math.floor(r() * 80));
      const risk = RISK_LEVELS[Math.floor(r() * RISK_LEVELS.length)];
      const gapWeight = [0, 2, 4][Math.floor(r() * 3)];
      const ctx = `case ${i} ${risk}@${gapWeight} — ${REPRO}`;

      const before = summaryOf(trades, risk, gapWeight);
      const beforeAlloc = allocations(trades, risk, gapWeight);
      const beforeTape = fills(trades, risk, gapWeight).tape;

      const nudged = perturb(trades, eps, r);
      assertInvariants(nudged, risk, gapWeight, ctx);
      compared++;

      const afterAlloc = allocations(nudged, risk, gapWeight);
      if (!sameDecisions(beforeAlloc, afterAlloc)) {
        // A genuine boundary case: allowed, but counted.
        flipped++;
        continue;
      }

      const after = summaryOf(nudged, risk, gapWeight);
      const afterTape = fills(nudged, risk, gapWeight).tape;

      expect(afterTape.length, `signal count changed: ${ctx}`).toBe(beforeTape.length);
      afterTape.forEach((f, k) => {
        expect(f.key, `fill order changed at ${k}: ${ctx}`).toBe(beforeTape[k].key);
        expect(f.clamped, `clamp reasons changed at ${k}: ${ctx}`).toBe(beforeTape[k].clamped);
        expect(Math.abs(f.size - beforeTape[k].size), `fill size moved at ${k}: ${ctx}`).toBeLessThan(
          tol(eps, beforeTape[k].size),
        );
      });

      expect(after.taken, `taken changed: ${ctx}`).toBe(before.taken);
      expect(after.peakConcurrent, `peak concurrency changed: ${ctx}`).toBe(before.peakConcurrent);
      for (const key of [
        "avgSize",
        "deployedPct",
        "cumulativeReturnPct",
        "maxDrawdownPct",
        "returnPerUnitPct",
        "winRatePct",
        "vsBaselinePp",
      ] as const) {
        const d = Math.abs(after[key] - before[key]);
        expect(d, `${key} moved ${d} under a ${eps} nudge: ${ctx}`).toBeLessThan(tol(eps, before[key]));
      }
    }

    // Decisions sitting inside their own numerical error would show up here.
    expect(flipped, `${flipped}/${compared} cases flipped a decision at 1e-12 — rankings are not separated`)
      .toBeLessThanOrEqual(Math.ceil(compared * 0.1));
  });

  it("tolerance scales with the perturbation, not with the cohort", () => {
    // 1e-9 is a thousand times 1e-12; the drift should grow roughly in step and
    // stay far below anything the UI renders.
    const trades = cohort(caseSeed(BASE_SEED, "scale", 0), 150);
    const risk: RiskLevel = "balanced";
    const before = summaryOf(trades, risk, 2);
    const beforeAlloc = allocations(trades, risk, 2);

    for (const eps of [1e-12, 1e-10, 1e-9]) {
      const nudged = perturb(trades, eps, rng(caseSeed(BASE_SEED, "scale-nudge", 0)));
      assertInvariants(nudged, risk, 2, `eps ${eps} — ${REPRO}`);
      if (!sameDecisions(beforeAlloc, allocations(nudged, risk, 2))) continue;
      const after = summaryOf(nudged, risk, 2);
      const drift = Math.abs(after.cumulativeReturnPct - before.cumulativeReturnPct);
      expect(drift, `return drifted ${drift} at eps ${eps} — ${REPRO}`).toBeLessThan(
        tol(eps, before.cumulativeReturnPct),
      );
      // Nothing at these magnitudes may move a displayed (2dp) number.
      expect(Math.round(after.cumulativeReturnPct * 100) / 100, `displayed return moved at eps ${eps}`).toBe(
        Math.round(before.cumulativeReturnPct * 100) / 100,
      );
    }
  });

  it("invariants hold even when a perturbation does flip a decision", () => {
    // Deliberately coarse nudges, big enough to reorder rankings. Continuity is
    // not claimed here — only that no cap, budget or sign rule can break.
    for (let i = 0; i < 40; i++) {
      const r = rng(caseSeed(BASE_SEED, "coarse", i));
      const trades = cohort(caseSeed(BASE_SEED, "coarse-cohort", i), 60 + Math.floor(r() * 120));
      const eps = [1e-6, 1e-4, 1e-2, 0.1][Math.floor(r() * 4)];
      const nudged = perturb(trades, eps, r);
      for (const risk of RISK_LEVELS) {
        assertInvariants(nudged, risk, 2, `coarse case ${i} eps ${eps} ${risk} — ${REPRO}`);
      }
    }
  });

  it("the whole grid stays stable under a 1e-12 nudge", () => {
    const eps = 1e-12;
    const trades = cohort(caseSeed(BASE_SEED, "grid", 0), 140);
    const nudged = perturb(trades, eps, rng(caseSeed(BASE_SEED, "grid-nudge", 0)));

    const before = buildExecutionGrid(trades, { limits: LIMITS });
    const after = buildExecutionGrid(nudged, { limits: LIMITS });
    expect(after.cells.length, `grid shape changed — ${REPRO}`).toBe(before.cells.length);

    let movedCells = 0;
    after.cells.forEach((cell, i) => {
      const ref = before.cells[i];
      const ctx = `${cell.risk}@${cell.gapWeight} — ${REPRO}`;
      expect(cell.risk, `cell order changed: ${ctx}`).toBe(ref.risk);
      expect(cell.gapWeight, `cell order changed: ${ctx}`).toBe(ref.gapWeight);
      if (cell.taken !== ref.taken) {
        movedCells++;
        return; // a boundary flip inside this cell; covered by the invariant test
      }
      expect(
        Math.abs(cell.cumulativeReturnPct - ref.cumulativeReturnPct),
        `cell return moved: ${ctx}`,
      ).toBeLessThan(tol(eps, ref.cumulativeReturnPct));
      expect(Math.abs(cell.deployedPct - ref.deployedPct), `cell deployment moved: ${ctx}`).toBeLessThan(
        tol(eps, ref.deployedPct),
      );
      expect(cell.limits.peakConcurrent, `cell peak concurrency moved: ${ctx}`).toBe(
        ref.limits.peakConcurrent,
      );
    });

    expect(movedCells, `${movedCells} of ${after.cells.length} grid cells flipped at 1e-12 — ${REPRO}`)
      .toBeLessThanOrEqual(Math.ceil(after.cells.length * 0.1));
    expect(
      Math.abs((after.best?.cumulativeReturnPct ?? 0) - (before.best?.cumulativeReturnPct ?? 0)),
      `headline best return moved — ${REPRO}`,
    ).toBeLessThan(tol(eps, before.best?.cumulativeReturnPct ?? 0));
  });

  it("a zero-magnitude perturbation is a no-op", () => {
    const trades = cohort(caseSeed(BASE_SEED, "zero", 0), 100);
    const same = perturb(trades, 0, rng(caseSeed(BASE_SEED, "zero-nudge", 0)));
    for (const risk of RISK_LEVELS) {
      expect(summaryOf(same, risk, 2), `zero nudge changed the summary (${risk}) — ${REPRO}`).toEqual(
        summaryOf(trades, risk, 2),
      );
      expect(fills(same, risk, 2).tape, `zero nudge changed the tape (${risk}) — ${REPRO}`).toEqual(
        fills(trades, risk, 2).tape,
      );
    }
  });
});
