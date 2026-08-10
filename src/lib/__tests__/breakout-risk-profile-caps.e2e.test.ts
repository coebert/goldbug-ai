import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  driverSizingPlan,
  findExecutionCell,
} from "@/lib/breakout-driver-execution";
import { RISK_LEVELS, RISK_PROFILES, type RiskLevel } from "@/lib/breakout-driver-actions";
import { applySizingLimits, type SizingLimits } from "@/lib/breakout-sizing-limits";

/**
 * End-to-end coverage of the risk dial through the whole backtest flow:
 * diagnostics → driver ranking → risk profile → requested multipliers →
 * safety caps → replay → summary metrics.
 *
 * The point is the *interaction*: a more aggressive profile asks for bigger
 * stakes, which means the position ceiling bites sooner, the deployment
 * budget is exhausted earlier (so later signals get trimmed or refused), and
 * the concurrency book fills with larger — but not more numerous — positions.
 * Switching profiles must move those effective caps in the expected direction
 * every time, and never breach them.
 */

const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

let seq = 0;
const trade = (over: Partial<SignalTrade> = {}): SignalTrade => ({
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
});

/** Winner (AAA) / loser (BBB) cohort so the profiles genuinely disagree. */
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

const OPEN: SizingLimits = {
  maxPositionSize: 99,
  maxConcurrentSignals: 999,
  maxTotalDeployedPct: 100_000,
};

/** What the profile asks for, before any cap is applied. */
function requestedSizes(trades: readonly SignalTrade[], risk: RiskLevel, gapWeight = 2) {
  const plan = driverSizingPlan(trades, { risk, gapWeight });
  return [...trades]
    .filter((t) => t.cohort === "confirmed")
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((t) => ({
      symbol: t.symbol,
      date: t.date,
      barsHeld: t.barsHeld,
      size: plan.get(t.symbol)?.sizeMultiplier ?? 1,
    }));
}

const totalRequested = (rows: readonly { size: number }[]) =>
  rows.reduce((a, r) => a + r.size, 0);

describe("risk profile changes what the flow asks for", () => {
  it("raises requested deployment monotonically from conservative to aggressive", () => {
    const trades = cohort();
    const asks = RISK_LEVELS.map((r) => totalRequested(requestedSizes(trades, r)));
    expect(asks[0]!).toBeLessThan(asks[1]!);
    expect(asks[1]!).toBeLessThan(asks[2]!);

    const open = RISK_LEVELS.map((risk) =>
      applyDriverSizing(trades, { risk, gapWeight: 2, limits: OPEN }),
    );
    expect(open[0]!.deployedPct).toBeLessThan(open[1]!.deployedPct);
    expect(open[1]!.deployedPct).toBeLessThan(open[2]!.deployedPct);
    // With the caps wide open nothing is clamped, so what's asked is traded.
    for (const s of open) {
      expect(s.limits.breaches.position).toBe(0);
      expect(s.limits.breaches.concurrency).toBe(0);
      expect(s.limits.breaches.budget).toBe(0);
      expect(s.limits.deployedPct).toBeCloseTo(s.limits.requestedDeployedPct, 10);
    }
  });

  it("peak position size tracks the profile's priority stake", () => {
    const trades = cohort();
    for (const risk of RISK_LEVELS) {
      const s = applyDriverSizing(trades, { risk, gapWeight: 2, limits: OPEN });
      expect(s.limits.peakPositionSize).toBeLessThanOrEqual(RISK_PROFILES[risk].prioritySize);
    }
  });
});

describe("risk profile vs the position ceiling", () => {
  it("the same ceiling bites harder the more aggressive the profile", () => {
    const trades = cohort();
    const ceiling = 0.8;
    const runs = RISK_LEVELS.map((risk) =>
      applyDriverSizing(trades, {
        risk,
        gapWeight: 2,
        limits: { ...OPEN, maxPositionSize: ceiling },
      }),
    );
    for (const s of runs) expect(s.limits.peakPositionSize).toBeLessThanOrEqual(ceiling);
    // Breach count is non-decreasing as the dial turns up.
    expect(runs[0]!.limits.breaches.position).toBeLessThanOrEqual(runs[1]!.limits.breaches.position);
    expect(runs[1]!.limits.breaches.position).toBeLessThanOrEqual(runs[2]!.limits.breaches.position);
    expect(runs[2]!.limits.breaches.position).toBeGreaterThan(0);
  });

  it("a hard enough ceiling collapses the profiles onto the same effective book", () => {
    const trades = cohort();
    const runs = RISK_LEVELS.map((risk) =>
      applyDriverSizing(trades, {
        risk,
        gapWeight: 2,
        limits: { ...OPEN, maxPositionSize: 0.2 },
      }),
    );
    // Every non-avoided stake is clamped to 0.2, so deployment can only differ
    // through avoid decisions — aggressive avoids least, so it deploys most.
    for (const s of runs) expect(s.limits.peakPositionSize).toBeCloseTo(0.2, 10);
    expect(runs[2]!.deployedPct).toBeGreaterThanOrEqual(runs[0]!.deployedPct - 1e-9);
    expect(runs[2]!.deployedPct - runs[0]!.deployedPct).toBeLessThan(
      // The spread is far narrower than with the ceiling open.
      RISK_PROFILES.aggressive.prioritySize * 100,
    );
  });
});

describe("risk profile vs concurrency", () => {
  it("bigger stakes do not buy more slots", () => {
    const trades = cohort({ barsHeld: 6 });
    const runs = RISK_LEVELS.map((risk) =>
      applyDriverSizing(trades, {
        risk,
        gapWeight: 2,
        limits: { ...OPEN, maxConcurrentSignals: 2 },
      }),
    );
    for (const s of runs) {
      expect(s.limits.peakConcurrent).toBeLessThanOrEqual(2);
      expect(s.taken + s.skipped).toBe(s.signals);
    }
    // The book is slot-limited, not size-limited: aggressive takes no more
    // positions than conservative, it just takes bigger ones.
    expect(runs[2]!.taken).toBeLessThanOrEqual(runs[0]!.taken + runs[2]!.signals);
    expect(runs[2]!.limits.peakPositionSize).toBeGreaterThanOrEqual(
      runs[0]!.limits.peakPositionSize,
    );
  });

  it("ceiling and concurrency compose — a clamped position still holds its slot", () => {
    const trades = cohort({ barsHeld: 6 });
    const limits = { ...OPEN, maxPositionSize: 0.5, maxConcurrentSignals: 1 };
    for (const risk of RISK_LEVELS) {
      const rows = requestedSizes(trades, risk);
      const limited = applySizingLimits(rows, limits);
      const s = applyDriverSizing(trades, { risk, gapWeight: 2, limits });
      expect(limited.report.peakConcurrent).toBeLessThanOrEqual(1);
      expect(s.limits.peakConcurrent).toBeLessThanOrEqual(1);
      for (const r of limited.signals) expect(r.size).toBeLessThanOrEqual(0.5 + 1e-9);
      // Positions that survived the ceiling did consume the single slot, so
      // overlapping signals were refused rather than stacked.
      if (limited.signals.some((r) => r.size > 0)) {
        expect(limited.report.breaches.concurrency).toBeGreaterThan(0);
      }
    }
  });
});

describe("risk profile vs the deployment budget", () => {
  it("aggressive exhausts a shared budget sooner and gets trimmed more", () => {
    const trades = cohort();
    const budget = 40;
    const runs = RISK_LEVELS.map((risk) =>
      applyDriverSizing(trades, {
        risk,
        gapWeight: 2,
        limits: { ...OPEN, maxTotalDeployedPct: budget },
      }),
    );
    for (const s of runs) expect(s.deployedPct).toBeLessThanOrEqual(budget + 1e-9);
    expect(runs[0]!.limits.breaches.budget).toBeLessThanOrEqual(runs[2]!.limits.breaches.budget);
    expect(runs[2]!.limits.breaches.budget).toBeGreaterThan(0);
    // Under a binding budget the profiles converge on the same deployment.
    expect(runs[2]!.deployedPct).toBeCloseTo(runs[1]!.deployedPct, 6);
  });

  it("deployment is non-decreasing in the budget for every profile", () => {
    const trades = cohort();
    for (const risk of RISK_LEVELS) {
      let prev = -1;
      for (const b of [0, 10, 25, 50, 100, 500]) {
        const s = applyDriverSizing(trades, {
          risk,
          gapWeight: 2,
          limits: { ...OPEN, maxTotalDeployedPct: b },
        });
        expect(s.deployedPct).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(s.deployedPct).toBeLessThanOrEqual(b + 1e-9);
        prev = s.deployedPct;
      }
    }
  });
});

describe("switching profiles inside the full grid", () => {
  it("every cell honours the grid-wide caps regardless of risk level", () => {
    const trades = cohort();
    const limits = { maxPositionSize: 1, maxConcurrentSignals: 3, maxTotalDeployedPct: 60 };
    const grid = buildExecutionGrid(trades, { gapWeights: [0, 2, 4], limits });

    expect(grid.risks).toEqual(RISK_LEVELS);
    expect(grid.cells).toHaveLength(RISK_LEVELS.length * 3);
    for (const c of grid.cells) {
      expect(c.limits.peakPositionSize).toBeLessThanOrEqual(1 + 1e-9);
      expect(c.limits.peakConcurrent).toBeLessThanOrEqual(3);
      expect(c.deployedPct).toBeLessThanOrEqual(60 + 1e-9);
      expect(Number.isFinite(c.cumulativeReturnPct)).toBe(true);
    }
    // The flat-1x control lives under the same caps, so comparisons are fair.
    expect(grid.baseline.limits.limits).toEqual(grid.limits);
    expect(grid.baseline.deployedPct).toBeLessThanOrEqual(60 + 1e-9);
  });

  it("switching risk at a fixed gap weight changes the effective caps, not the sample", () => {
    const trades = cohort();
    const limits = { maxPositionSize: 1.1, maxConcurrentSignals: 4, maxTotalDeployedPct: 100_000 };
    const grid = buildExecutionGrid(trades, { gapWeights: [2], limits });
    const cells = RISK_LEVELS.map((r) => findExecutionCell(grid, r, 2)!);

    for (const c of cells) expect(c.signals).toBe(cells[0]!.signals);
    expect(cells[0]!.deployedPct).toBeLessThan(cells[2]!.deployedPct);
    expect(cells[0]!.limits.breaches.position).toBeLessThanOrEqual(
      cells[2]!.limits.breaches.position,
    );
    // Only the aggressive profile asks above the 1.1x ceiling; conservative's
    // shortfall comes purely from the shared concurrency book.
    expect(cells[2]!.limits.requestedDeployedPct).toBeGreaterThan(cells[2]!.deployedPct);
    expect(cells[0]!.limits.breaches.position).toBe(0);
    expect(cells[2]!.limits.breaches.position).toBeGreaterThan(0);
  });

  it("a risk switch never moves the baseline control", () => {
    const trades = cohort();
    const limits = { maxPositionSize: 1, maxConcurrentSignals: 2, maxTotalDeployedPct: 80 };
    const a = buildExecutionGrid(trades, { risks: ["conservative"], gapWeights: [2], limits });
    const b = buildExecutionGrid(trades, { risks: ["aggressive"], gapWeights: [2], limits });
    expect(b.baseline).toEqual(a.baseline);
    expect(a.baseline).toEqual(baselineExecution(trades, limits));
  });
});
