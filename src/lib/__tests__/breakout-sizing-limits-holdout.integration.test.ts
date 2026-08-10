import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { applyDriverSizing, driverSizingPlan } from "@/lib/breakout-driver-execution";
import { applySizingLimits, type SizingLimits } from "@/lib/breakout-sizing-limits";
import { splitHoldout, type DateWindow } from "@/lib/walk-forward-holdout";

/**
 * Safety caps across the *final rolling holdout*.
 *
 * The existing integration suite proves the caps bind inside a single
 * execution replay. The holdout runs the frozen strategy over consecutive
 * unseen segments, so the caps have to bind per segment as well: a segment is
 * its own book (its own concurrency slots and its own deployment budget) and
 * nothing may leak across the boundary from the trainable window. These tests
 * also pin budget monotonicity on that path — tightening the budget can only
 * ever reduce deployment, never increase it, in every segment.
 */

const FROM = "2020-01-01";
const TO = "2024-12-31";
const HOLDOUT_DAYS = 270;
const SEGMENT_DAYS = 90;

const iso = (base: string, delta: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

const inWindow = (date: string, w: DateWindow) => date >= w.from && date <= w.to;

let seq = 0;
const trade = (over: Partial<SignalTrade> = {}): SignalTrade => ({
  symbol: "AAA",
  date: FROM,
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
  barsHeld: 6,
  returnPct: 2,
  maxAdversePct: -1,
  maxFavourablePct: 3,
  ...over,
});

/**
 * Fill a window with a winner/loser pair per cohort so the driver panel ranks
 * the symbols apart and hands back genuinely different multipliers.
 */
function tradesIn(w: DateWindow, count = 8, barsHeld = 6): SignalTrade[] {
  const out: SignalTrade[] = [];
  for (let i = 0; i < count; i++) {
    const date = iso(w.from, i * 2);
    if (!inWindow(date, w)) break;
    out.push(trade({ symbol: "AAA", date, returnPct: 4, barsHeld }));
    out.push(trade({ symbol: "BBB", date, returnPct: -4, barsHeld }));
    out.push(trade({ symbol: "AAA", date, cohort: "failed", returnPct: -1, barsHeld }));
    out.push(trade({ symbol: "BBB", date, cohort: "failed", returnPct: 3, barsHeld }));
  }
  seq += out.length;
  return out;
}

const split = () =>
  splitHoldout({ from: FROM, to: TO, holdoutDays: HOLDOUT_DAYS, segmentDays: SEGMENT_DAYS });

const OPEN: SizingLimits = {
  maxPositionSize: 99,
  maxConcurrentSignals: 999,
  maxTotalDeployedPct: 100_000,
};

function segmentRuns(limits: Partial<SizingLimits>, barsHeld = 6) {
  const s = split();
  return s.segments.map((w) => ({
    window: w,
    trades: tradesIn(w, 8, barsHeld),
    result: applyDriverSizing(tradesIn(w, 8, barsHeld), {
      risk: "aggressive" as const,
      gapWeight: 2,
      limits,
    }),
  }));
}

describe("holdout segmentation feeding the caps", () => {
  it("tiles the holdout and keeps every generated signal inside its own segment", () => {
    const s = split();
    expect(s.holdout).not.toBeNull();
    expect(s.segments).toHaveLength(3);
    for (const w of s.segments) {
      const trades = tradesIn(w);
      expect(trades.length).toBeGreaterThan(0);
      for (const t of trades) {
        expect(inWindow(t.date, w)).toBe(true);
        expect(t.date >= s.holdout!.from).toBe(true);
        expect(t.date > s.trainable.to).toBe(true);
      }
    }
  });
});

describe("position ceiling across holdout segments", () => {
  it("clamps every segment independently and reports the clamped deployment", () => {
    const open = segmentRuns(OPEN);
    const capped = segmentRuns({ ...OPEN, maxPositionSize: 1 });

    expect(open.some((r) => r.result.limits.peakPositionSize > 1)).toBe(true);
    for (let i = 0; i < capped.length; i++) {
      const c = capped[i]!.result;
      expect(c.limits.peakPositionSize).toBeLessThanOrEqual(1);
      expect(c.deployedPct).toBeLessThanOrEqual(open[i]!.result.deployedPct + 1e-9);
      expect(c.avgSize).toBeCloseTo(c.deployedPct / 100, 10);
    }
    expect(capped.some((r) => r.result.limits.breaches.position > 0)).toBe(true);
  });

  it("zeroes the whole holdout when the ceiling is zero", () => {
    for (const r of segmentRuns({ ...OPEN, maxPositionSize: 0 })) {
      expect(r.result.deployedPct).toBe(0);
      expect(r.result.taken).toBe(0);
      expect(r.result.cumulativeReturnPct).toBe(0);
    }
  });
});

describe("concurrency across holdout segments", () => {
  it("never exceeds the slot count in any segment and books the rest as skipped", () => {
    const narrow = segmentRuns({ ...OPEN, maxConcurrentSignals: 1 });
    const wide = segmentRuns(OPEN);
    for (let i = 0; i < narrow.length; i++) {
      const n = narrow[i]!.result;
      expect(n.limits.peakConcurrent).toBeLessThanOrEqual(1);
      expect(n.taken + n.skipped).toBe(n.signals);
      expect(n.taken).toBeLessThanOrEqual(wide[i]!.result.taken);
    }
    expect(narrow.some((r) => r.result.limits.breaches.concurrency > 0)).toBe(true);
  });

  it("does not carry open positions across a segment boundary", () => {
    // Long holds that would still be open at the segment edge: because each
    // segment is replayed as its own book, the first signal in a segment can
    // never be refused for concurrency inherited from the previous one.
    for (const r of segmentRuns({ ...OPEN, maxConcurrentSignals: 2 }, 400)) {
      const confirmed = r.trades
        .filter((t) => t.cohort === "confirmed")
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const plan = driverSizingPlan(r.trades, { risk: "aggressive", gapWeight: 2 });
      const limited = applySizingLimits(
        confirmed.map((t) => ({
          symbol: t.symbol,
          date: t.date,
          barsHeld: t.barsHeld,
          size: plan.get(t.symbol)?.sizeMultiplier ?? 1,
        })),
        { ...OPEN, maxConcurrentSignals: 2 },
      );
      expect(limited.signals[0]!.clamped).not.toContain("concurrency");
      expect(limited.report.peakConcurrent).toBeLessThanOrEqual(2);
    }
  });
});

describe("budget monotonicity across holdout segments", () => {
  const budgets = [0, 10, 25, 50, 100, 200];

  it("deployment is non-decreasing in the budget, in every segment", () => {
    const runs = budgets.map((b) => segmentRuns({ ...OPEN, maxTotalDeployedPct: b }));
    const segCount = runs[0]!.length;
    for (let s = 0; s < segCount; s++) {
      for (let i = 1; i < runs.length; i++) {
        const prev = runs[i - 1]![s]!.result.deployedPct;
        const next = runs[i]![s]!.result.deployedPct;
        expect(next).toBeGreaterThanOrEqual(prev - 1e-9);
      }
      expect(runs[0]![s]!.result.deployedPct).toBe(0);
    }
  });

  it("never deploys more than the budget allows in any segment", () => {
    for (const b of budgets) {
      for (const r of segmentRuns({ ...OPEN, maxTotalDeployedPct: b })) {
        expect(r.result.deployedPct).toBeLessThanOrEqual(b + 1e-9);
      }
    }
  });

  it("spends the budget monotonically within a segment and stops at the cap", () => {
    const s = split();
    for (const w of s.segments) {
      const trades = tradesIn(w);
      const confirmed = trades
        .filter((t) => t.cohort === "confirmed")
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const plan = driverSizingPlan(trades, { risk: "aggressive", gapWeight: 2 });
      const limits = { ...OPEN, maxTotalDeployedPct: 40 };
      const limited = applySizingLimits(
        confirmed.map((t) => ({
          symbol: t.symbol,
          date: t.date,
          barsHeld: t.barsHeld,
          size: plan.get(t.symbol)?.sizeMultiplier ?? 1,
        })),
        limits,
      );

      const budget = (confirmed.length * limits.maxTotalDeployedPct) / 100;
      let spent = 0;
      let prev = 0;
      for (const row of limited.signals) {
        expect(Number.isFinite(row.size)).toBe(true);
        expect(row.size).toBeGreaterThanOrEqual(0);
        expect(row.size).toBeLessThanOrEqual(row.requestedSize + 1e-9);
        spent += row.size;
        expect(spent).toBeGreaterThanOrEqual(prev);
        expect(spent).toBeLessThanOrEqual(budget + 1e-9);
        prev = spent;
      }
      expect(limited.report.deployedPct).toBeLessThanOrEqual(limits.maxTotalDeployedPct + 1e-9);
      expect(limited.report.requestedDeployedPct).toBeGreaterThanOrEqual(
        limited.report.deployedPct - 1e-9,
      );
    }
  });

  it("keeps each segment's budget separate — the holdout total is per-segment, not shared", () => {
    const runs = segmentRuns({ ...OPEN, maxTotalDeployedPct: 60 });
    // A shared budget would starve later segments; each one gets its own.
    for (const r of runs) expect(r.result.deployedPct).toBeGreaterThan(0);
    const last = runs[runs.length - 1]!.result.deployedPct;
    const first = runs[0]!.result.deployedPct;
    expect(Math.abs(last - first)).toBeLessThan(1e-9);
  });
});
