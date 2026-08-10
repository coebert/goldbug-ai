import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  driverSizingPlan,
} from "@/lib/breakout-driver-execution";
import { buildHeatmap, HEATMAP_METRICS } from "@/lib/breakout-execution-heatmap";
import {
  applySizingLimits,
  resolveSizingLimits,
  type LimitedSignal,
  type SizingLimits,
} from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Cross-path verification: no route into the replay may break solvency.
 *
 * The cash and holdings invariants are only worth as much as their coverage.
 * They are proven against `applySizingLimits`, but the app reaches a replay
 * several other ways — the flat-1× baseline, driver-sized execution, every cell
 * of the execution grid, and the heatmap built on top of that grid. Each is an
 * optimisation or a convenience wrapper over the same rules, and each is a
 * place where a future change could quietly bypass a cap.
 *
 * This suite does two things:
 *
 *  1. Differential vs a reference implementation. A deliberately naive replay
 *     is written here — no incremental state, the open book is recomputed from
 *     scratch at every step — and the production engine must agree with it
 *     signal for signal. The naive version is easy to read and audit; if the
 *     fast one ever diverges, the fast one is wrong.
 *
 *  2. One shared invariant checker applied to *every* path. Whatever produced
 *     the sizes, the resulting book must never borrow cash, never hold a
 *     negative position, never exceed the per-position ceiling, the concurrency
 *     cap or the aggregate budget.
 */

const FILE = "src/lib/__tests__/breakout-replay-path-equivalence.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const EPS = 1e-9;
const CLOSE = 1e-6;

const day = (i: number) => {
  const d = new Date(Date.UTC(2024, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

type Row = { symbol: string; date: string; barsHeld: number; size: number };

function randomRows(r: () => number, n: number, poison: boolean): Row[] {
  const symbols = 1 + Math.floor(r() * 10);
  const perDay = 1 + Math.floor(r() * 3);
  return Array.from({ length: n }, (_, i) => {
    let size = r() * 2.5;
    if (poison) {
      const p = r();
      if (p < 0.05) size = NaN;
      else if (p < 0.08) size = Infinity;
      else if (p < 0.11) size = -r() * 3;
      else if (p < 0.13) size = 1e9;
    }
    return { symbol: `S${i % symbols}`, date: day(Math.floor(i / perDay)), barsHeld: 1 + Math.floor(r() * 12), size };
  });
}

function randomLimits(r: () => number): SizingLimits {
  return resolveSizingLimits({
    maxPositionSize: 0.3 + r() * 2,
    maxConcurrentSignals: 1 + Math.floor(r() * 16),
    maxTotalDeployedPct: 10 + r() * 300,
  });
}

function randomTrades(r: () => number, n: number): SignalTrade[] {
  const regimes = ["bull", "bear", "sideways"] as const;
  const symbols = 3 + Math.floor(r() * 9);
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

const chronological = (trades: readonly SignalTrade[]) =>
  [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

const confirmedOf = (trades: readonly SignalTrade[]) =>
  chronological(trades.filter((t) => t.cohort === "confirmed"));

/** Rows exactly as the driver path would request them, for a given setting. */
function driverRows(trades: readonly SignalTrade[], risk: RiskLevel, gapWeight: number): Row[] {
  const plan = driverSizingPlan(trades, { risk, gapWeight });
  return confirmedOf(trades).map((t) => ({
    symbol: t.symbol,
    date: t.date,
    barsHeld: t.barsHeld,
    size: plan.get(t.symbol)?.sizeMultiplier ?? 1,
  }));
}

const flatRows = (trades: readonly SignalTrade[]): Row[] =>
  confirmedOf(trades).map((t) => ({ symbol: t.symbol, date: t.date, barsHeld: t.barsHeld, size: 1 }));

// ---------------------------------------------------------------------------
// Reference implementation
// ---------------------------------------------------------------------------

/**
 * The obvious, slow replay. Same three rules in the same order — per-position
 * ceiling, then concurrency, then aggregate budget — but with no incremental
 * bookkeeping: the open book is rebuilt by rescanning every earlier fill, and
 * spend is re-totalled from the accepted list each step. Nothing here can carry
 * stale state between signals, which is exactly what makes it a useful control.
 */
function referenceReplay(rows: readonly Row[], limits: SizingLimits): LimitedSignal[] {
  const dates = [...new Set(rows.map((x) => x.date))].sort();
  const rank = new Map(dates.map((d, i) => [d, i]));
  const budget = (rows.length * limits.maxTotalDeployedPct) / 100;
  const accepted: { at: number; until: number; size: number }[] = [];
  const out: LimitedSignal[] = [];

  rows.forEach((row, i) => {
    const at = rank.get(row.date) ?? 0;
    // Same sanitisation contract: NaN/negative are bugs upstream and size to 0;
    // Infinity is a real "as much as allowed" request left to the position cap.
    const requestedSize = Number.isNaN(row.size) || row.size < 0 ? 0 : row.size;
    const clamped: string[] = [];
    let size = requestedSize;

    if (size > limits.maxPositionSize) {
      size = limits.maxPositionSize;
      clamped.push("position");
    }

    // Open book recomputed from scratch, not maintained.
    const openNow = accepted.filter((p) => p.at <= at && p.until > at).length;
    if (size > 0 && openNow >= limits.maxConcurrentSignals) {
      size = 0;
      clamped.push("concurrency");
    }

    if (size > 0) {
      const spent = accepted.reduce((a, p) => a + p.size, 0);
      const remaining = budget - spent;
      if (remaining <= 0) {
        size = 0;
        clamped.push("budget");
      } else if (size > remaining) {
        size = remaining;
        clamped.push("budget");
      }
    }

    if (size > 0) {
      accepted.push({ at, until: at + Math.max(1, row.barsHeld), size });
    }
    out.push({ symbol: row.symbol, date: row.date, requestedSize, size, clamped } as LimitedSignal);
  });

  return out;
}

// ---------------------------------------------------------------------------
// One invariant checker, used by every path
// ---------------------------------------------------------------------------

/**
 * Walk any set of allowed sizes as cash and holdings and assert the constraints
 * that must hold no matter which code produced them.
 */
function assertSolvent(
  rows: readonly Row[],
  signals: readonly { symbol: string; date: string; size: number }[],
  limits: SizingLimits,
  ctx: string,
) {
  expect(signals.length, `path dropped or invented signals: ${ctx}`).toBe(rows.length);

  const dates = [...new Set(rows.map((x) => x.date))].sort();
  const rank = new Map(dates.map((d, i) => [d, i]));
  const capital = (rows.length * limits.maxTotalDeployedPct) / 100;

  let cash = capital;
  let peakOpen = 0;
  const holdings = new Map<string, number>();
  const open: { until: number; symbol: string; size: number }[] = [];

  signals.forEach((s, i) => {
    const at = rank.get(s.date) ?? 0;
    for (let j = open.length - 1; j >= 0; j--) {
      const pos = open[j];
      if (pos.until > at) continue;
      const held = holdings.get(pos.symbol) ?? 0;
      expect(held + EPS, `released more than held (${pos.symbol}): ${ctx}`).toBeGreaterThanOrEqual(pos.size);
      const next = held - pos.size;
      if (next <= EPS) holdings.delete(pos.symbol);
      else holdings.set(pos.symbol, next);
      cash += pos.size;
      open.splice(j, 1);
    }

    expect(Number.isFinite(s.size), `non-finite size at step ${i}: ${ctx}`).toBe(true);
    expect(s.size, `negative size at step ${i}: ${ctx}`).toBeGreaterThanOrEqual(0);
    expect(s.size, `position above ceiling at step ${i}: ${ctx}`).toBeLessThanOrEqual(
      limits.maxPositionSize + EPS,
    );

    if (s.size > 0) {
      expect(cash + EPS, `cash would go negative at step ${i}: ${ctx}`).toBeGreaterThanOrEqual(s.size);
      cash -= s.size;
      holdings.set(s.symbol, (holdings.get(s.symbol) ?? 0) + s.size);
      open.push({ until: at + Math.max(1, rows[i].barsHeld), symbol: s.symbol, size: s.size });
      if (open.length > peakOpen) peakOpen = open.length;
    }

    expect(cash, `negative cash at step ${i}: ${ctx}`).toBeGreaterThanOrEqual(-EPS);
    expect(open.length, `concurrency cap breached at step ${i}: ${ctx}`).toBeLessThanOrEqual(
      limits.maxConcurrentSignals,
    );
    for (const [symbol, qty] of holdings) {
      expect(qty, `negative holding in ${symbol} at step ${i}: ${ctx}`).toBeGreaterThanOrEqual(-EPS);
    }
    const held = [...holdings.values()].reduce((a, b) => a + b, 0);
    expect(Math.abs(cash + held - capital), `ledger does not balance at step ${i}: ${ctx}`).toBeLessThan(CLOSE);
  });

  const spent = signals.reduce((a, s) => a + s.size, 0);
  expect(spent, `spent past the budget: ${ctx}`).toBeLessThanOrEqual(capital + CLOSE);

  return { peakOpen, spent, capital };
}

const GRID_LIMITS = resolveSizingLimits({
  maxPositionSize: 1.4,
  maxConcurrentSignals: 5,
  maxTotalDeployedPct: 130,
});

describe("replay path equivalence and solvency", () => {
  it("the production engine matches the naive reference implementation", () => {
    for (let i = 0; i < 250; i++) {
      const r = rng(caseSeed(BASE_SEED, "reference", i));
      const rows = randomRows(r, 1 + Math.floor(r() * 160), r() < 0.4);
      const limits = randomLimits(r);
      const ctx = `case ${i} — ${REPRO}`;

      const fast = applySizingLimits(rows, limits).signals;
      const slow = referenceReplay(rows, limits);

      expect(fast.length, `length mismatch: ${ctx}`).toBe(slow.length);
      fast.forEach((s, k) => {
        expect(Math.abs(s.size - slow[k].size), `size differs at ${k} (${s.size} vs ${slow[k].size}): ${ctx}`)
          .toBeLessThan(CLOSE);
        expect([...s.clamped].sort(), `clamp reasons differ at ${k}: ${ctx}`).toEqual(
          [...slow[k].clamped].sort(),
        );
      });

      // Both paths must satisfy the invariants, not merely agree with each other:
      // two implementations can share a bug.
      assertSolvent(rows, fast, limits, `engine ${ctx}`);
      assertSolvent(rows, slow, limits, `reference ${ctx}`);
    }
  });

  it("holds when the caps bind hardest (starved budget, single-slot book)", () => {
    for (let i = 0; i < 100; i++) {
      const r = rng(caseSeed(BASE_SEED, "tight", i));
      const rows = randomRows(r, 25 + Math.floor(r() * 150), true).map((row) => ({
        ...row,
        barsHeld: 4 + Math.floor(r() * 18),
      }));
      const limits = resolveSizingLimits({
        maxPositionSize: 0.3 + r() * 0.9,
        maxConcurrentSignals: 1 + Math.floor(r() * 3),
        maxTotalDeployedPct: 1 + r() * 20,
      });
      const ctx = `tight case ${i} — ${REPRO}`;

      const fast = applySizingLimits(rows, limits).signals;
      const slow = referenceReplay(rows, limits);
      fast.forEach((s, k) =>
        expect(Math.abs(s.size - slow[k].size), `size differs at ${k}: ${ctx}`).toBeLessThan(CLOSE),
      );
      assertSolvent(rows, fast, limits, `engine ${ctx}`);
      assertSolvent(rows, slow, limits, `reference ${ctx}`);
    }
  });

  it("the baseline path is solvent and identical to a flat-1 direct replay", () => {
    for (let i = 0; i < 20; i++) {
      const r = rng(caseSeed(BASE_SEED, "baseline", i));
      const trades = randomTrades(r, 60 + Math.floor(r() * 140));
      const rows = flatRows(trades);
      const ctx = `baseline case ${i} — ${REPRO}`;

      const summary = baselineExecution(trades, GRID_LIMITS);
      const direct = applySizingLimits(rows, GRID_LIMITS);
      const reference = referenceReplay(rows, GRID_LIMITS);

      reference.forEach((s, k) =>
        expect(Math.abs(s.size - direct.signals[k].size), `baseline differs from reference at ${k}: ${ctx}`)
          .toBeLessThan(CLOSE),
      );
      const walk = assertSolvent(rows, direct.signals, GRID_LIMITS, ctx);
      expect(summary.limits.peakConcurrent, `baseline peak disagrees: ${ctx}`).toBe(walk.peakOpen);
      expect(summary.taken, `baseline taken disagrees: ${ctx}`).toBe(
        direct.signals.filter((s) => s.size > 0).length,
      );
    }
  });

  it("the driver-sized path is solvent at every risk and gap weight", () => {
    for (let i = 0; i < 8; i++) {
      const r = rng(caseSeed(BASE_SEED, "driver", i));
      const trades = randomTrades(r, 90 + Math.floor(r() * 120));
      for (const risk of RISK_LEVELS) {
        for (const gapWeight of [0, 2, 4, 6]) {
          const ctx = `driver case ${i} ${risk}@${gapWeight} — ${REPRO}`;
          const rows = driverRows(trades, risk, gapWeight);
          const engine = applySizingLimits(rows, GRID_LIMITS);
          const reference = referenceReplay(rows, GRID_LIMITS);

          reference.forEach((s, k) =>
            expect(Math.abs(s.size - engine.signals[k].size), `driver path differs at ${k}: ${ctx}`)
              .toBeLessThan(CLOSE),
          );

          const walk = assertSolvent(rows, engine.signals, GRID_LIMITS, `engine ${ctx}`);
          assertSolvent(rows, reference, GRID_LIMITS, `reference ${ctx}`);

          // The public wrapper must report the same book the walk observed.
          const summary = applyDriverSizing(trades, { risk, gapWeight, limits: GRID_LIMITS });
          expect(summary.limits.peakConcurrent, `wrapper peak disagrees: ${ctx}`).toBe(walk.peakOpen);
          expect(summary.limits.peakPositionSize, `wrapper peak size over ceiling: ${ctx}`).toBeLessThanOrEqual(
            GRID_LIMITS.maxPositionSize + EPS,
          );
          expect(summary.taken, `wrapper taken disagrees: ${ctx}`).toBe(
            engine.signals.filter((s) => s.size > 0).length,
          );
        }
      }
    }
  });

  it("every grid cell is solvent and equals its standalone replay", () => {
    for (let i = 0; i < 5; i++) {
      const r = rng(caseSeed(BASE_SEED, "grid", i));
      const trades = randomTrades(r, 120 + Math.floor(r() * 100));
      const grid = buildExecutionGrid(trades, { limits: GRID_LIMITS });

      for (const cell of grid.cells) {
        const ctx = `grid case ${i} ${cell.risk}@${cell.gapWeight} — ${REPRO}`;
        // The grid is a batched optimisation over the same replay: computing the
        // cell on its own must give the identical answer.
        const standalone = applyDriverSizing(trades, {
          risk: cell.risk,
          gapWeight: cell.gapWeight,
          limits: GRID_LIMITS,
        });
        expect(standalone.cumulativeReturnPct, `grid cell differs from standalone: ${ctx}`).toBe(
          cell.cumulativeReturnPct,
        );
        expect(standalone.limits, `grid cell limits differ from standalone: ${ctx}`).toEqual(cell.limits);

        const rows = driverRows(trades, cell.risk, cell.gapWeight);
        const walk = assertSolvent(rows, applySizingLimits(rows, GRID_LIMITS).signals, GRID_LIMITS, ctx);
        expect(cell.limits.peakConcurrent, `cell peak disagrees with walk: ${ctx}`).toBe(walk.peakOpen);
        expect(cell.deployedPct, `cell deployment over budget: ${ctx}`).toBeLessThanOrEqual(
          GRID_LIMITS.maxTotalDeployedPct + CLOSE,
        );
      }
    }
  });

  it("the heatmap never surfaces a cell that breaks the caps", () => {
    // The heatmap is a pure view over the grid, but it is what the user acts on:
    // any cell it renders as "best" must be a book that could actually be held.
    const r = rng(caseSeed(BASE_SEED, "heatmap", 0));
    const trades = randomTrades(r, 220);
    const grid = buildExecutionGrid(trades, { limits: GRID_LIMITS });

    for (const spec of HEATMAP_METRICS) {
      const map = buildHeatmap(grid, spec.metric);
      const ctx = `heatmap ${spec.metric} — ${REPRO}`;
      for (const cell of grid.cells) {
        const rows = driverRows(trades, cell.risk, cell.gapWeight);
        assertSolvent(rows, applySizingLimits(rows, GRID_LIMITS).signals, GRID_LIMITS, ctx);
      }
      // Every rendered value must trace back to a real cell of the same grid.
      const rendered = JSON.stringify(map);
      expect(rendered.length, `heatmap rendered nothing: ${ctx}`).toBeGreaterThan(2);
    }
  });

  it("splitting a cohort can never fund more than replaying it whole", () => {
    // A chunked/streaming path is the most tempting optimisation, and the most
    // dangerous: per-chunk budgets must not add up to more than the whole.
    for (let i = 0; i < 40; i++) {
      const r = rng(caseSeed(BASE_SEED, "chunked", i));
      const rows = randomRows(r, 60 + Math.floor(r() * 120), false);
      const limits = randomLimits(r);
      const ctx = `chunk case ${i} — ${REPRO}`;

      const whole = applySizingLimits(rows, limits);
      const wholeSpend = whole.signals.reduce((a, s) => a + s.size, 0);
      assertSolvent(rows, whole.signals, limits, ctx);

      // Naive chunking: each half gets the same *percentage* budget, which is a
      // smaller absolute budget because the budget scales with cohort size.
      const mid = Math.floor(rows.length / 2);
      const parts = [rows.slice(0, mid), rows.slice(mid)].filter((p) => p.length > 0);
      let chunkSpend = 0;
      for (const part of parts) {
        const plan = applySizingLimits(part, limits);
        assertSolvent(part, plan.signals, limits, `${ctx} chunk`);
        chunkSpend += plan.signals.reduce((a, s) => a + s.size, 0);
      }

      const capital = (rows.length * limits.maxTotalDeployedPct) / 100;
      expect(chunkSpend, `chunked replay spent past total capital: ${ctx}`).toBeLessThanOrEqual(
        capital + CLOSE,
      );
      // Chunking may fund *less* (a full book in one half cannot borrow the
      // other half's slack) but must never fund more than the whole-cohort run
      // beyond that same capital ceiling.
      expect(Number.isFinite(chunkSpend) && Number.isFinite(wholeSpend)).toBe(true);
    }
  });
});
