import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  chronological,
  driverSizingPlan,
  type ExecutionSummary,
} from "@/lib/breakout-driver-execution";
import {
  applySizingLimits,
  resolveSizingLimits,
  type LimitedPlan,
  type SizingLimits,
} from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Differential tests: the step-by-step ledger vs the replay summary.
 *
 * Two independent things describe the same replay. The engine reports
 * aggregates (deployed %, peak concurrency, peak position size, taken/skipped,
 * compounded return, drawdown, cap breaches) computed inline while it sizes.
 * A user reasoning about the run instead walks it step by step: cash out, cash
 * back, what is on the book right now.
 *
 * If those two ever disagree, the numbers on screen stop describing the trades
 * that were actually taken — the failure mode that produced the equity/holdings
 * inaccuracies this app has fought before. So here the ledger is rebuilt from
 * the plan alone, entry by entry and exit by exit, every aggregate is
 * *recomputed* from that walk, and each one is asserted against the engine's
 * own summary field. Nothing is read back from the report to derive the
 * comparison value.
 */

const FILE = "src/lib/__tests__/breakout-ledger-summary-differential.test.ts";
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
    }
    return { symbol: `S${i % symbols}`, date: day(Math.floor(i / perDay)), barsHeld: 1 + Math.floor(r() * 12), size };
  });
}

function randomLimits(r: () => number): SizingLimits {
  return resolveSizingLimits({
    maxPositionSize: 0.3 + r() * 2,
    maxConcurrentSignals: 1 + Math.floor(r() * 16),
    maxTotalDeployedPct: 15 + r() * 300,
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

// ---------------------------------------------------------------------------
// The independent ledger
// ---------------------------------------------------------------------------

type LedgerTotals = {
  entries: number;
  refusals: number;
  totalDeployed: number;
  avgSize: number;
  deployedPct: number;
  peakConcurrent: number;
  peakPositionSize: number;
  reduced: number;
  perSymbol: Map<string, number>;
  cashOut: number;
  cashBack: number;
  terminalCash: number;
  maxHeld: number;
};

/**
 * Walk the plan as cash and holdings, one signal at a time, and total up
 * everything the summary claims — without consulting the summary.
 */
function walkLedger(rows: readonly Row[], plan: LimitedPlan, capital: number, ctx: string): LedgerTotals {
  const dates = [...new Set(rows.map((x) => x.date))].sort();
  const rank = new Map(dates.map((d, i) => [d, i]));

  let cash = capital;
  let cashOut = 0;
  let cashBack = 0;
  let entries = 0;
  let refusals = 0;
  let totalDeployed = 0;
  let peakConcurrent = 0;
  let peakPositionSize = 0;
  let reduced = 0;
  let maxHeld = 0;
  const perSymbol = new Map<string, number>();
  const holdings = new Map<string, number>();
  const open: { until: number; symbol: string; size: number }[] = [];

  const release = (upTo: number) => {
    for (let j = open.length - 1; j >= 0; j--) {
      const pos = open[j];
      if (pos.until > upTo) continue;
      const held = holdings.get(pos.symbol) ?? 0;
      const next = held - pos.size;
      if (next <= EPS) holdings.delete(pos.symbol);
      else holdings.set(pos.symbol, next);
      cash += pos.size;
      cashBack += pos.size;
      open.splice(j, 1);
    }
  };

  plan.signals.forEach((s, i) => {
    const at = rank.get(s.date) ?? 0;
    release(at);

    // `requestedSize` is already sanitised by the engine (NaN → 0, negatives
    // → 0, Infinity kept as "as much as allowed"), so a reduction is simply an
    // allowed size below the request — including Infinity clamped to the cap.
    if (s.size < s.requestedSize - EPS) reduced++;

    if (s.size > 0) {
      entries++;
      totalDeployed += s.size;
      cash -= s.size;
      cashOut += s.size;
      holdings.set(s.symbol, (holdings.get(s.symbol) ?? 0) + s.size);
      perSymbol.set(s.symbol, (perSymbol.get(s.symbol) ?? 0) + s.size);
      open.push({ until: at + Math.max(1, rows[i].barsHeld), symbol: s.symbol, size: s.size });
      if (s.size > peakPositionSize) peakPositionSize = s.size;
      if (open.length > peakConcurrent) peakConcurrent = open.length;
    } else {
      refusals++;
    }

    const held = [...holdings.values()].reduce((a, b) => a + b, 0);
    if (held > maxHeld) maxHeld = held;
    expect(cash, `ledger cash went negative at step ${i}: ${ctx}`).toBeGreaterThanOrEqual(-EPS);
  });

  release(Number.POSITIVE_INFINITY);
  expect(holdings.size, `ledger left positions open: ${ctx}`).toBe(0);

  const n = plan.signals.length;
  return {
    entries,
    refusals,
    totalDeployed,
    avgSize: n ? totalDeployed / n : 0,
    deployedPct: n ? (totalDeployed / n) * 100 : 0,
    peakConcurrent,
    peakPositionSize,
    reduced,
    perSymbol,
    cashOut,
    cashBack,
    terminalCash: cash,
    maxHeld,
  };
}

/** Every summary field the ledger can independently reproduce. */
function assertLedgerMatchesReport(rows: readonly Row[], limits: SizingLimits, ctx: string) {
  const plan = applySizingLimits(rows, limits);
  const capital = (rows.length * limits.maxTotalDeployedPct) / 100;
  const led = walkLedger(rows, plan, capital, ctx);
  const rep = plan.report;

  // Deployment: the report's average allowed size must equal the ledger's own
  // sum of what actually left the cash account.
  expect(Math.abs(rep.deployedPct - led.deployedPct), `deployedPct disagrees with ledger: ${ctx}`).toBeLessThan(
    CLOSE,
  );
  expect(rep.peakConcurrent, `peakConcurrent disagrees with ledger: ${ctx}`).toBe(led.peakConcurrent);
  expect(
    Math.abs(rep.peakPositionSize - led.peakPositionSize),
    `peakPositionSize disagrees with ledger: ${ctx}`,
  ).toBeLessThan(CLOSE);

  // Cap breaches: a reduction seen by the ledger must be labelled, and a label
  // must correspond to a reduction. Counts differ only because one signal can
  // trip several caps, so compare against the de-duplicated label count.
  const labelled = plan.signals.filter((s) => s.clamped.length > 0).length;
  expect(labelled, `clamp labels disagree with observed reductions: ${ctx}`).toBe(led.reduced);
  const breachTotal = rep.breaches.position + rep.breaches.concurrency + rep.breaches.budget;
  expect(breachTotal, `breach total is below the reduced-signal count: ${ctx}`).toBeGreaterThanOrEqual(
    led.reduced,
  );

  // Conservation: everything that left the cash account came back.
  expect(Math.abs(led.cashOut - led.cashBack), `cash out != cash back: ${ctx}`).toBeLessThan(CLOSE);
  expect(Math.abs(led.terminalCash - capital), `terminal cash != capital: ${ctx}`).toBeLessThan(CLOSE);
  expect(led.maxHeld, `book exceeded granted capital: ${ctx}`).toBeLessThanOrEqual(capital + CLOSE);

  return { plan, led, capital };
}

/**
 * Recompute an ExecutionSummary's headline numbers from a per-signal walk of
 * the sized cohort, mirroring how a reader would total the trade list.
 */
function recomputeSummary(sized: readonly { returnPct: number; size: number }[]) {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let totalSize = 0;
  let taken = 0;
  let wins = 0;
  let contribution = 0;

  for (const t of sized) {
    totalSize += t.size;
    if (t.size > 0) {
      taken++;
      if (t.returnPct > 0) wins++;
    }
    const step = (t.returnPct * t.size) / 100;
    contribution += t.returnPct * t.size;
    equity *= 1 + step;
    if (equity > peak) peak = equity;
    const dd = (equity / peak - 1) * 100;
    if (dd < maxDd) maxDd = dd;
  }

  const n = sized.length;
  return {
    signals: n,
    taken,
    skipped: n - taken,
    avgSize: n ? totalSize / n : 0,
    deployedPct: n ? (totalSize / n) * 100 : 0,
    winRatePct: taken ? (wins / taken) * 100 : 0,
    avgReturnPct: n ? contribution / n : 0,
    cumulativeReturnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDd,
  };
}

function assertSummaryMatches(summary: ExecutionSummary, sized: readonly { returnPct: number; size: number }[], ctx: string) {
  const re = recomputeSummary(sized);
  expect(summary.signals, `signals disagree: ${ctx}`).toBe(re.signals);
  expect(summary.taken, `taken disagrees: ${ctx}`).toBe(re.taken);
  expect(summary.skipped, `skipped disagrees: ${ctx}`).toBe(re.skipped);
  expect(summary.taken + summary.skipped, `taken+skipped != signals: ${ctx}`).toBe(re.signals);
  for (const [field, a, b] of [
    ["avgSize", summary.avgSize, re.avgSize],
    ["deployedPct", summary.deployedPct, re.deployedPct],
    ["winRatePct", summary.winRatePct, re.winRatePct],
    ["avgReturnPct", summary.avgReturnPct, re.avgReturnPct],
    ["cumulativeReturnPct", summary.cumulativeReturnPct, re.cumulativeReturnPct],
    ["maxDrawdownPct", summary.maxDrawdownPct, re.maxDrawdownPct],
  ] as const) {
    expect(Math.abs(a - b), `${field} disagrees with the walked trades (${a} vs ${b}): ${ctx}`).toBeLessThan(
      CLOSE,
    );
  }
  return re;
}

/** Rebuild the exact sized trade list a replay would have executed. */
function sizedTrades(trades: readonly SignalTrade[], sizes: readonly number[]) {
  const confirmed = chronological(trades.filter((t) => t.cohort === "confirmed"));
  return confirmed.map((t, i) => ({ returnPct: t.returnPct, size: sizes[i] }));
}

function requestedSizes(trades: readonly SignalTrade[], risk: RiskLevel, gapWeight: number) {
  const plan = driverSizingPlan(trades, { risk, gapWeight });
  const confirmed = chronological(trades.filter((t) => t.cohort === "confirmed"));
  return confirmed.map((t) => ({
    symbol: t.symbol,
    date: t.date,
    barsHeld: t.barsHeld,
    size: plan.get(t.symbol)?.sizeMultiplier ?? 1,
  }));
}

const LIMITS = resolveSizingLimits({
  maxPositionSize: 1.5,
  maxConcurrentSignals: 6,
  maxTotalDeployedPct: 150,
});

describe("ledger vs summary (differential)", () => {
  it("limit report totals equal the step-by-step ledger across random cohorts", () => {
    for (let i = 0; i < 250; i++) {
      const r = rng(caseSeed(BASE_SEED, "report", i));
      const rows = randomRows(r, 1 + Math.floor(r() * 220), r() < 0.4);
      const limits = randomLimits(r);
      assertLedgerMatchesReport(rows, limits, `case ${i} — ${REPRO}`);
    }
  });

  it("agrees under starved budgets and tight books, where most signals are clamped", () => {
    for (let i = 0; i < 120; i++) {
      const r = rng(caseSeed(BASE_SEED, "starved", i));
      const rows = randomRows(r, 30 + Math.floor(r() * 180), true).map((row) => ({
        ...row,
        barsHeld: 4 + Math.floor(r() * 20),
      }));
      const limits = resolveSizingLimits({
        maxPositionSize: 0.4 + r() * 1.2,
        maxConcurrentSignals: 1 + Math.floor(r() * 5),
        maxTotalDeployedPct: 1 + r() * 25,
      });
      const { led } = assertLedgerMatchesReport(rows, limits, `starved case ${i} — ${REPRO}`);
      expect(led.entries + led.refusals, `entries+refusals != signals — ${REPRO}`).toBe(rows.length);
    }
  });

  it("execution summary totals equal the walked trade list at every risk and gap weight", () => {
    for (let i = 0; i < 12; i++) {
      const r = rng(caseSeed(BASE_SEED, "summary", i));
      const trades = randomTrades(r, 80 + Math.floor(r() * 160));
      for (const risk of RISK_LEVELS) {
        for (const gapWeight of [0, 2, 4, 6]) {
          const ctx = `case ${i} ${risk}@${gapWeight} — ${REPRO}`;
          const summary = applyDriverSizing(trades, { risk, gapWeight, limits: LIMITS });
          // Reconstruct the allowed sizes independently, then walk them.
          const limited = applySizingLimits(requestedSizes(trades, risk, gapWeight), LIMITS);
          const sized = sizedTrades(trades, limited.signals.map((s) => s.size));
          assertSummaryMatches(summary, sized, ctx);

          // And the summary's embedded limit report must match the same walk.
          const rows = requestedSizes(trades, risk, gapWeight);
          const led = walkLedger(rows, limited, (rows.length * LIMITS.maxTotalDeployedPct) / 100, ctx);
          expect(summary.limits.peakConcurrent, `summary peakConcurrent disagrees: ${ctx}`).toBe(
            led.peakConcurrent,
          );
          expect(Math.abs(summary.deployedPct - led.deployedPct), `summary deployedPct disagrees: ${ctx}`).toBeLessThan(
            CLOSE,
          );
          expect(summary.taken, `summary taken disagrees with ledger entries: ${ctx}`).toBe(led.entries);
        }
      }
    }
  });

  it("baseline summary equals a flat-1 ledger walk", () => {
    for (let i = 0; i < 20; i++) {
      const r = rng(caseSeed(BASE_SEED, "baseline", i));
      const trades = randomTrades(r, 60 + Math.floor(r() * 140));
      const ctx = `baseline case ${i} — ${REPRO}`;

      const summary = baselineExecution(trades, LIMITS);
      const confirmed = chronological(trades.filter((t) => t.cohort === "confirmed"));
      const rows = confirmed.map((t) => ({ symbol: t.symbol, date: t.date, barsHeld: t.barsHeld, size: 1 }));
      const limited = applySizingLimits(rows, LIMITS);

      assertSummaryMatches(summary, sizedTrades(trades, limited.signals.map((s) => s.size)), ctx);
      const led = walkLedger(rows, limited, (rows.length * LIMITS.maxTotalDeployedPct) / 100, ctx);
      expect(summary.taken, `baseline taken disagrees with ledger: ${ctx}`).toBe(led.entries);
      expect(Math.abs(summary.avgSize - led.avgSize), `baseline avgSize disagrees: ${ctx}`).toBeLessThan(CLOSE);
    }
  });

  it("grid deltas equal the difference of two independently walked ledgers", () => {
    for (let i = 0; i < 6; i++) {
      const r = rng(caseSeed(BASE_SEED, "grid", i));
      const trades = randomTrades(r, 120 + Math.floor(r() * 120));
      const grid = buildExecutionGrid(trades, { limits: LIMITS });

      const baseRows = chronological(trades.filter((t) => t.cohort === "confirmed"))
        .map((t) => ({ symbol: t.symbol, date: t.date, barsHeld: t.barsHeld, size: 1 }));
      const baseWalk = recomputeSummary(
        sizedTrades(trades, applySizingLimits(baseRows, LIMITS).signals.map((s) => s.size)),
      );

      for (const cell of grid.cells) {
        const ctx = `grid case ${i} ${cell.risk}@${cell.gapWeight} — ${REPRO}`;
        const rows = requestedSizes(trades, cell.risk, cell.gapWeight);
        const walk = recomputeSummary(
          sizedTrades(trades, applySizingLimits(rows, LIMITS).signals.map((s) => s.size)),
        );

        // Each delta the UI renders must equal the difference of the two walks,
        // not just the difference of two reported numbers.
        expect(
          Math.abs(cell.vsBaseline.cumulativeReturnPp - (walk.cumulativeReturnPct - baseWalk.cumulativeReturnPct)),
          `cumulative delta disagrees with ledgers: ${ctx}`,
        ).toBeLessThan(CLOSE);
        expect(
          Math.abs(cell.vsBaseline.deployedPp - (walk.deployedPct - baseWalk.deployedPct)),
          `deployment delta disagrees with ledgers: ${ctx}`,
        ).toBeLessThan(CLOSE);
        expect(
          Math.abs(cell.vsBaseline.maxDrawdownPp - (walk.maxDrawdownPct - baseWalk.maxDrawdownPct)),
          `drawdown delta disagrees with ledgers: ${ctx}`,
        ).toBeLessThan(CLOSE);
        expect(
          Math.abs(cell.vsBaseline.avgReturnPp - (walk.avgReturnPct - baseWalk.avgReturnPct)),
          `avg return delta disagrees with ledgers: ${ctx}`,
        ).toBeLessThan(CLOSE);
      }
    }
  });

  it("agrees on degenerate cohorts (empty, single signal, all-zero sizes)", () => {
    const ctx = `degenerate — ${REPRO}`;

    const empty = applySizingLimits([], LIMITS);
    const emptyLed = walkLedger([], empty, 0, ctx);
    expect(empty.report.deployedPct).toBe(emptyLed.deployedPct);
    expect(empty.report.peakConcurrent).toBe(emptyLed.peakConcurrent);

    const one: Row[] = [{ symbol: "S0", date: day(0), barsHeld: 3, size: 0.8 }];
    assertLedgerMatchesReport(one, LIMITS, ctx);

    const zeros: Row[] = Array.from({ length: 15 }, (_, i) => ({
      symbol: `S${i % 3}`,
      date: day(i),
      barsHeld: 2,
      size: 0,
    }));
    const { led } = assertLedgerMatchesReport(zeros, LIMITS, ctx);
    expect(led.entries, `zero sizes should fund nothing: ${ctx}`).toBe(0);
    expect(led.deployedPct, `zero sizes should deploy nothing: ${ctx}`).toBe(0);
  });
});
