import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  driverSizingPlan,
} from "@/lib/breakout-driver-execution";
import { resolveSizingLimits, type SizingLimits } from "@/lib/breakout-sizing-limits";

/**
 * Snapshot coverage for the full replay summary.
 *
 * The other suites assert invariants — caps hold, slots balance, budgets bind.
 * Invariants survive a lot of unintended drift: a change to the ranking tie
 * break, the unranked default size, or the order the caps are applied can
 * leave every invariant true while quietly moving the allocations and P&L the
 * dashboard reports.
 *
 * These snapshots pin the *values*: which symbols get sized and how much, how
 * many signals each cap bit, and the resulting P&L deltas versus the flat-1×
 * baseline. A deliberate logic change should update them in one obvious diff;
 * an accidental one should show up as a failure rather than a silently
 * different number on the Analytics page.
 *
 * Everything is rounded before snapshotting so float noise across platforms
 * never causes a spurious failure — the precision kept is the precision the UI
 * actually displays.
 */

const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

/**
 * A fixed, hand-shaped cohort — deliberately not seeded-random, so the
 * snapshot is readable and a diff points at a real behavioural change rather
 * than a reshuffled generator.
 *
 * Shape: four symbols with distinct edge profiles (a clear winner, a clear
 * loser, a marginal name, and one too thin to rank), overlapping hold windows
 * so concurrency bites, and a mix of regimes.
 */
const PROFILES: { symbol: string; count: number; returns: number[]; barsHeld: number }[] = [
  { symbol: "WINR", count: 12, returns: [4.2, 3.1, 5.4, -1.2], barsHeld: 5 },
  { symbol: "LOSR", count: 12, returns: [-3.4, -2.1, 1.2, -4.6], barsHeld: 6 },
  { symbol: "MARG", count: 10, returns: [1.1, -0.9, 0.6, -0.4], barsHeld: 3 },
  { symbol: "THIN", count: 2, returns: [2.0, -1.0], barsHeld: 4 },
];

function fixture(): SignalTrade[] {
  const regimes = ["bull", "sideways", "bear"] as const;
  const out: SignalTrade[] = [];
  let i = 0;
  for (const p of PROFILES) {
    for (let n = 0; n < p.count; n++) {
      const ret = p.returns[n % p.returns.length];
      // Every fourth signal is a failed breakout so the diagnostics have a
      // contrast cohort to compute expectancy gaps against.
      const confirmed = n % 4 !== 3;
      out.push({
        symbol: p.symbol,
        date: day(i * 2),
        cohort: confirmed ? "confirmed" : "failed",
        direction: "up",
        side: "long",
        regime: regimes[n % regimes.length],
        realisedVol20d: 0.008 + (n % 5) * 0.002,
        atrPct: 0.015 + (n % 3) * 0.005,
        quality: 0.5 + (n % 5) / 10,
        penetrationAtr: 0.4 + (n % 4) * 0.2,
        volumeRatio: 1.1 + (n % 3) * 0.3,
        falseBreakoutRate: 0.15 + (n % 4) * 0.05,
        ageBars: 1 + (n % 4),
        pendingLatencyBars: n % 3,
        entry: 100,
        exit: 100 + ret,
        exitReason: ret >= 0 ? "target" : "stop",
        barsHeld: p.barsHeld,
        returnPct: confirmed ? ret : ret * 0.4,
        maxAdversePct: -Math.abs(ret),
        maxFavourablePct: Math.abs(ret) * 1.5,
      } as SignalTrade);
      i++;
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const TRADES = fixture();

const LIMITS: SizingLimits = resolveSizingLimits({
  maxPositionSize: 1.5,
  maxConcurrentSignals: 4,
  maxTotalDeployedPct: 120,
});

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The allocation side: what each ranked symbol was told to do, and how big. */
const planShape = (risk: RiskLevel, gapWeight: number) =>
  [...driverSizingPlan(TRADES, { risk, gapWeight }).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, rec]) => `${symbol} ${rec.action} ${r2(rec.sizeMultiplier)}x`);

/** The execution side: caps applied and the P&L that survived them. */
const summaryShape = (risk: RiskLevel, gapWeight: number) => {
  const s = applyDriverSizing(TRADES, { risk, gapWeight, limits: LIMITS });
  const base = baselineExecution(TRADES, LIMITS);
  return {
    taken: `${s.taken}/${s.signals}`,
    avgSize: r2(s.avgSize),
    deployedPct: r2(s.deployedPct),
    caps: s.limits.breaches,
    peakConcurrent: s.limits.peakConcurrent,
    peakPositionSize: r2(s.limits.peakPositionSize),
    winRatePct: r2(s.winRatePct),
    cumulativeReturnPct: r2(s.cumulativeReturnPct),
    maxDrawdownPct: r2(s.maxDrawdownPct),
    returnPerUnitPct: r2(s.returnPerUnitPct),
    vsBaselinePp: r2(s.cumulativeReturnPct - base.cumulativeReturnPct),
  };
};

describe("backtest replay summary snapshots", () => {
  it("fixture cohort is stable", () => {
    const confirmed = TRADES.filter((t) => t.cohort === "confirmed").length;
    expect({ total: TRADES.length, confirmed, symbols: PROFILES.length }).toMatchInlineSnapshot();
  });

  it("baseline (flat 1x) replay", () => {
    const b = baselineExecution(TRADES, LIMITS);
    expect({
      taken: `${b.taken}/${b.signals}`,
      deployedPct: r2(b.deployedPct),
      caps: b.limits.breaches,
      peakConcurrent: b.limits.peakConcurrent,
      winRatePct: r2(b.winRatePct),
      cumulativeReturnPct: r2(b.cumulativeReturnPct),
      maxDrawdownPct: r2(b.maxDrawdownPct),
    }).toMatchInlineSnapshot();
  });

  it("allocations per risk level at gap weight 2", () => {
    const byRisk = Object.fromEntries(RISK_LEVELS.map((risk) => [risk, planShape(risk, 2)]));
    expect(byRisk).toMatchInlineSnapshot();
  });

  it("allocations shift with expectancy-gap weight (balanced risk)", () => {
    const byWeight = Object.fromEntries([0, 2, 4, 6].map((w) => [w, planShape(RISK_LEVELS[1], w)]));
    expect(byWeight).toMatchInlineSnapshot();
  });

  it("replay summary per risk level at gap weight 2", () => {
    const byRisk = Object.fromEntries(RISK_LEVELS.map((risk) => [risk, summaryShape(risk, 2)]));
    expect(byRisk).toMatchInlineSnapshot();
  });

  it("full grid: return, drawdown and deployment per cell", () => {
    const grid = buildExecutionGrid(TRADES, { limits: LIMITS });
    const cells = grid.cells.map(
      (c) =>
        `${c.risk} @${c.gapWeight} → ret ${r2(c.cumulativeReturnPct)}% (${r2(c.vsBaseline.cumulativeReturnPp)}pp) dd ${r2(c.maxDrawdownPct)}% dep ${r2(c.deployedPct)}% taken ${c.taken}`,
    );
    expect(cells).toMatchInlineSnapshot();
  });

  it("grid best cell and headline summary", () => {
    const grid = buildExecutionGrid(TRADES, { limits: LIMITS });
    expect({
      best: grid.best ? `${grid.best.risk} @${grid.best.gapWeight}` : null,
      bestReturnPct: grid.best ? r2(grid.best.cumulativeReturnPct) : null,
      summary: grid.summary,
    }).toMatchInlineSnapshot();
  });
});
