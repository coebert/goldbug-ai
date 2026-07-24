// Cross-check: the portfolio performance chart's displayed profit
// and % change (via `buildDepositAdjustedSeries` /
// `trailingAdjustedPct`) must exclude deposit / cash-flow events in
// the same way `computeModeSummary` does for the dashboard tile.
//
// The two helpers use different algorithms:
//   - computeModeSummary works on a prev→last window delta and nets
//     out deposits that landed strictly after prev, up to & including
//     last.
//   - buildDepositAdjustedSeries subtracts a cumulative deposit
//     total from every point after the baseline (points[0]).
//
// They must agree on the *displayed* numbers whenever the window
// they describe is the same window — the natural case is a chart
// whose baseline is the same as the summary's `prev` snapshot.
// These tests pin that equivalence, plus deposit-invariance and
// withdrawal handling, with both fixtures and property-based checks.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  buildDepositAdjustedSeries,
  trailingAdjustedPct,
  type DepositPoint,
  type EquityPoint,
} from "../deposit-adjusted-series";
import {
  computeModeSummary,
  type DepositEvent,
  type SummaryPortfolio,
  type SummarySeriesRow,
} from "../mode-summary";

// ---------------------------------------------------------------------------
// Test helpers: convert single-portfolio equity + deposits into the
// shapes computeModeSummary expects, keyed by a fixed portfolio id.

const PID = "p1";
const PORTS: SummaryPortfolio[] = [{ id: PID, mode: "sim" }];

const seriesRows = (points: EquityPoint[]): SummarySeriesRow[] =>
  points.map((p) => ({ date: p.date, [PID]: p.equity }));

const depositEvents = (deps: DepositPoint[]): DepositEvent[] =>
  deps.map((d) => ({ portfolio_id: PID, date: d.date, amount: d.amount }));

// Chart baseline is points[0] and its "trailing" = last point. We
// compare against a two-point summary window whose `prev` is
// points[0], so both formulas describe the same span.
const twoPointWindow = (points: EquityPoint[]): EquityPoint[] => [
  points[0],
  points[points.length - 1],
];

const round = (n: number, dp = 6) => Number(n.toFixed(dp));

describe("chart deposit exclusion — parity with computeModeSummary", () => {
  it("no deposits: trailing pct matches summary pct", () => {
    const pts: EquityPoint[] = [
      { date: "2024-01-01", equity: 1_000 },
      { date: "2024-02-01", equity: 1_050 },
      { date: "2024-03-01", equity: 1_100 },
    ];
    const chartPct = trailingAdjustedPct(pts, []);
    const summary = computeModeSummary(seriesRows(twoPointWindow(pts)), PORTS, []);
    expect(round(chartPct)).toBe(round(summary!.sim.pct));
    // £1000 → £1100 = +10%
    expect(round(chartPct)).toBe(10);
  });

  it("mid-window deposit contributes 0 to both trailing pct and pnl", () => {
    const pts: EquityPoint[] = [
      { date: "2024-01-01", equity: 1_000 },
      { date: "2024-02-15", equity: 1_200 }, // deposit landed here
      { date: "2024-03-01", equity: 1_200 },
    ];
    const deps: DepositPoint[] = [{ date: "2024-02-15", amount: 200 }];

    const adj = buildDepositAdjustedSeries(pts, deps);
    const chartPnl = adj[adj.length - 1].adjusted - adj[0].equity;
    const chartPct = adj[adj.length - 1].pct;

    const summary = computeModeSummary(
      seriesRows(twoPointWindow(pts)),
      PORTS,
      depositEvents(deps),
    );

    expect(round(chartPnl)).toBe(0);
    expect(round(chartPct)).toBe(0);
    expect(round(summary!.sim.pnl)).toBe(0);
    expect(round(summary!.sim.pct)).toBe(0);
  });

  it("deposit dated ON baseline is baked into baseline in both helpers", () => {
    // Same-day-as-baseline deposits sit inside the starting equity
    // and are NOT netted out by either helper. £200 growth is real.
    const pts: EquityPoint[] = [
      { date: "2024-01-01", equity: 1_000 },
      { date: "2024-02-01", equity: 1_200 },
    ];
    const deps: DepositPoint[] = [{ date: "2024-01-01", amount: 500 }];

    const chartPct = trailingAdjustedPct(pts, deps);
    const summary = computeModeSummary(seriesRows(pts), PORTS, depositEvents(deps));

    // (1200 - 1000) / 1000 * 100 = 20%
    expect(round(chartPct)).toBe(20);
    expect(round(summary!.sim.pct)).toBe(20);
    expect(round(summary!.sim.pnl)).toBe(200);
  });

  it("withdrawal (negative deposit) is added back to trading pnl", () => {
    const pts: EquityPoint[] = [
      { date: "2024-01-01", equity: 1_000 },
      { date: "2024-02-01", equity: 900 }, // user pulled £100 out
    ];
    const deps: DepositPoint[] = [{ date: "2024-02-01", amount: -100 }];

    const adj = buildDepositAdjustedSeries(pts, deps);
    const chartPnl = adj[adj.length - 1].adjusted - adj[0].equity;
    const summary = computeModeSummary(seriesRows(pts), PORTS, depositEvents(deps));

    // Trading was flat: 900 - (-100) - 1000 = 0
    expect(round(chartPnl)).toBe(0);
    expect(round(adj[adj.length - 1].pct)).toBe(0);
    expect(round(summary!.sim.pnl)).toBe(0);
    expect(round(summary!.sim.pct)).toBe(0);
  });

  it("multiple mid-window deposits: chart & summary both net all of them out", () => {
    const pts: EquityPoint[] = [
      { date: "2024-01-01", equity: 1_000 },
      { date: "2024-01-15", equity: 1_400 }, // +200 deposit, +200 gain
      { date: "2024-02-01", equity: 1_900 }, // +300 deposit, +200 gain
      { date: "2024-03-01", equity: 2_000 }, // +100 gain
    ];
    const deps: DepositPoint[] = [
      { date: "2024-01-15", amount: 200 },
      { date: "2024-02-01", amount: 300 },
    ];

    const adj = buildDepositAdjustedSeries(pts, deps);
    const chartPnl = adj[adj.length - 1].adjusted - adj[0].equity;
    const summary = computeModeSummary(
      seriesRows(twoPointWindow(pts)),
      PORTS,
      depositEvents(deps),
    );

    // Trading gains total 200+200+100 = 500; deposits 500 netted out.
    expect(round(chartPnl)).toBe(500);
    expect(round(adj[adj.length - 1].pct)).toBe(50);
    expect(round(summary!.sim.pnl)).toBe(500);
    expect(round(summary!.sim.pct)).toBe(50);
  });

  it("includeDeposits=true on summary matches RAW chart delta (no adjustment)", () => {
    // Parity in the opposite direction: when the tile toggles ON
    // "include deposits", it must match the raw equity delta the
    // chart would show without the adjustment helper.
    const pts: EquityPoint[] = [
      { date: "2024-01-01", equity: 1_000 },
      { date: "2024-02-01", equity: 1_400 },
    ];
    const deps: DepositPoint[] = [{ date: "2024-01-15", amount: 200 }];

    const rawDelta = pts[1].equity - pts[0].equity;
    const rawPct = (rawDelta / pts[0].equity) * 100;
    const summary = computeModeSummary(
      seriesRows(pts),
      PORTS,
      depositEvents(deps),
      { includeDeposits: true },
    );
    expect(round(summary!.sim.pnl)).toBe(round(rawDelta));
    expect(round(summary!.sim.pct)).toBe(round(rawPct));
  });
});

describe("chart deposit exclusion — property-based parity", () => {
  it("trailing pct == summary pct for any (equity, deposits) at the same window", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000 }),
        fc.integer({ min: 100, max: 100_000 }),
        fc.integer({ min: -5_000, max: 5_000 }),
        (start, end, deposit) => {
          const pts: EquityPoint[] = [
            { date: "2024-01-01", equity: start },
            { date: "2024-02-01", equity: end },
          ];
          const deps: DepositPoint[] = [{ date: "2024-01-15", amount: deposit }];

          const chartPct = trailingAdjustedPct(pts, deps);
          const summary = computeModeSummary(seriesRows(pts), PORTS, depositEvents(deps));

          // Both helpers must agree to within float precision.
          expect(chartPct).toBeCloseTo(summary!.sim.pct, 8);

          // Trading pnl the chart shows equals what the summary
          // reports as pnl.
          const adj = buildDepositAdjustedSeries(pts, deps);
          const chartPnl = adj[adj.length - 1].adjusted - adj[0].equity;
          expect(chartPnl).toBeCloseTo(summary!.sim.pnl, 8);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("adding a same-day baseline deposit never changes chart pnl or pct", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 50_000 }),
        fc.integer({ min: 500, max: 50_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        (start, end, sameDayDeposit) => {
          const pts: EquityPoint[] = [
            { date: "2024-01-01", equity: start },
            { date: "2024-02-01", equity: end },
          ];
          const noDeps = buildDepositAdjustedSeries(pts, []);
          const withDeps = buildDepositAdjustedSeries(pts, [
            { date: "2024-01-01", amount: sameDayDeposit },
          ]);
          expect(withDeps[withDeps.length - 1].pct).toBeCloseTo(
            noDeps[noDeps.length - 1].pct,
            8,
          );
          expect(withDeps[withDeps.length - 1].adjusted).toBeCloseTo(
            noDeps[noDeps.length - 1].adjusted,
            8,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("chart pct is invariant to post-baseline deposit magnitude when trading is flat", () => {
    // If equity moves by exactly the deposit amount, both helpers
    // must report ~0% and ~0 pnl regardless of how large the deposit.
    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 50_000 }),
        fc.integer({ min: 1, max: 20_000 }),
        (start, deposit) => {
          const pts: EquityPoint[] = [
            { date: "2024-01-01", equity: start },
            { date: "2024-02-01", equity: start + deposit },
          ];
          const deps: DepositPoint[] = [{ date: "2024-01-15", amount: deposit }];

          const chartPct = trailingAdjustedPct(pts, deps);
          const summary = computeModeSummary(seriesRows(pts), PORTS, depositEvents(deps));

          expect(chartPct).toBeCloseTo(0, 8);
          expect(summary!.sim.pct).toBeCloseTo(0, 8);
          expect(summary!.sim.pnl).toBeCloseTo(0, 8);
        },
      ),
      { numRuns: 200 },
    );
  });
});

