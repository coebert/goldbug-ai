// End-to-end regression: for portfolios that receive MULTIPLE deposits
// (and mixed deposit + withdrawal events) the daily equity % change
// surfaced on every UI surface MUST exclude those cash flows.
//
// Surfaces covered here — same fixtures fed to each:
//   1. Daily bar chart on the portfolio page
//      → `computeDailyEquityChanges` (per-day pct)
//   2. Home-page portfolio card range % badge (1W / 1M / 3M / 1Y / All)
//      → `computeCardRangePct` (trailing pct over a sliced window)
//   3. Dashboard "Today" mode-summary tile
//      → `computeModeSummary` (pnl/pct over the last two snapshots)
//
// The contract this locks in:
//   - Every per-day pct in the bar chart equals `tradingPnl / prevEquity`,
//     NEVER `rawDelta / prevEquity` — so a mid-window deposit day plots
//     the trading residual (often 0) instead of a phantom spike.
//   - The card badge's trailing pct is capital-adjusted:
//     `tradingPnl / (baseline + netFlow)`, and drops to 0 when a day's
//     equity moves purely because of cash-in/out.
//   - The mode-summary tile matches the card badge for the same window.
//   - Adding, splitting, or reshuffling deposit events (same net flow)
//     leaves every reported pnl bit-exactly unchanged.
//
// Regression target: prevents any future path from double-counting a
// deposit as a trading gain on the daily chart, card badge, or tile.

import { describe, expect, it } from "vitest";

import {
  computeDailyEquityChanges,
  type DepositLite,
  type EquitySnapshotLite,
} from "../daily-equity-changes";
import { computeCardRangePct } from "../card-range-pct";
import {
  computeModeSummary,
  type DepositEvent,
  type SummaryPortfolio,
  type SummarySeriesRow,
} from "../mode-summary";

const PID = "live-1";
const PORTS: SummaryPortfolio[] = [{ id: PID, mode: "live_prod" }];

const eq = (rows: Array<[string, number]>): EquitySnapshotLite[] =>
  rows.map(([snapshot_date, total_value]) => ({ snapshot_date, total_value }));

const spark = (rows: Array<[string, number]>) =>
  rows.map(([date, value]) => ({ date, value }));

const series = (rows: Array<[string, number]>): SummarySeriesRow[] =>
  rows.map(([date, v]) => ({ date, [PID]: v }));

const depsChart = (rows: Array<[string, number]>): DepositLite[] =>
  rows.map(([date, amount]) => ({ date, amount }));

const depsCard = (rows: Array<[string, number]>) =>
  rows.map(([date, amount]) => ({ date, amount }));

const depsSummary = (rows: Array<[string, number]>): DepositEvent[] =>
  rows.map(([date, amount]) => ({ portfolio_id: PID, date, amount }));

describe("multi-deposit portfolios: daily % excludes cash flows on every surface", () => {
  it("day the deposit lands is a pure cash-in — chart bar reports 0% pnl, not the raw jump", () => {
    // Day 1 £1000, Day 2 £1200 (all from a £200 deposit, zero trading).
    // A daily bar chart must show ~0% for day 2, not +20%.
    const rows: Array<[string, number]> = [
      ["2026-07-01", 1000],
      ["2026-07-02", 1200],
    ];
    const deposits: Array<[string, number]> = [["2026-07-02", 200]];

    const daily = computeDailyEquityChanges(eq(rows), depsChart(deposits));
    expect(daily).toHaveLength(1);
    expect(daily[0].netFlow).toBe(200);
    expect(daily[0].rawDelta).toBe(200);
    expect(daily[0].pnl).toBe(0);
    expect(daily[0].pct).toBe(0);

    // Card badge and summary tile must agree.
    expect(computeCardRangePct(spark(rows), depsCard(deposits), false)).toBe(0);
    const s = computeModeSummary(series(rows), PORTS, depsSummary(deposits));
    expect(s?.real.pnl).toBe(0);
    expect(s?.real.pct).toBe(0);
  });

  it("multiple deposits across the window: each day's chart pct reflects trading only", () => {
    // 4-day fixture with two deposits (£200 on day 2, £300 on day 3) and
    // £10/day trading gain. Every per-day pct must equal 10/prev, never
    // the deposit-inflated raw delta.
    const rows: Array<[string, number]> = [
      ["2026-07-01", 1000],
      ["2026-07-02", 1210], // +£10 trading + £200 deposit
      ["2026-07-03", 1520], // +£10 trading + £300 deposit
      ["2026-07-04", 1530], // +£10 trading, no flow
    ];
    const deposits: Array<[string, number]> = [
      ["2026-07-02", 200],
      ["2026-07-03", 300],
    ];

    const daily = computeDailyEquityChanges(eq(rows), depsChart(deposits));
    expect(daily).toHaveLength(3);

    // Day-by-day trading pnl is £10; deposits are netted out.
    expect(daily[0].pnl).toBeCloseTo(10, 10);
    expect(daily[0].pct).toBeCloseTo((10 / 1000) * 100, 10);
    expect(daily[1].pnl).toBeCloseTo(10, 10);
    expect(daily[1].pct).toBeCloseTo((10 / 1210) * 100, 10);
    expect(daily[2].pnl).toBeCloseTo(10, 10);
    expect(daily[2].pct).toBeCloseTo((10 / 1520) * 100, 10);

    // Card badge over the full window: trading pnl = £30, capital
    // adjusted denom = 1000 + 500 = 1500.
    const cardPct = computeCardRangePct(spark(rows), depsCard(deposits), false)!;
    expect(cardPct).toBeCloseTo((30 / 1500) * 100, 10);
  });

  it("mixed deposit + withdrawal events across the window net symmetrically", () => {
    // 5 snapshots, 4 flows: +200, -50, +100, -30 = +£220 net. Trading
    // adds £20 over the whole window. Every daily bar must strip flows.
    const rows: Array<[string, number]> = [
      ["2026-07-01", 2000],
      ["2026-07-02", 2205], // +5 trading + 200 deposit
      ["2026-07-03", 2160], // +5 trading − 50 withdrawal
      ["2026-07-04", 2265], // +5 trading + 100 deposit
      ["2026-07-05", 2240], // +5 trading − 30 withdrawal
    ];
    const deposits: Array<[string, number]> = [
      ["2026-07-02", 200],
      ["2026-07-03", -50],
      ["2026-07-04", 100],
      ["2026-07-05", -30],
    ];

    const daily = computeDailyEquityChanges(eq(rows), depsChart(deposits));
    for (const d of daily) expect(d.pnl).toBeCloseTo(5, 10);

    // Card badge is a trailing metric across the whole window; the
    // mode-summary tile anchors on the last two snapshots only. Both
    // strip flows from their respective windows.
    const cardPct = computeCardRangePct(spark(rows), depsCard(deposits), false)!;
    const summary = computeModeSummary(series(rows), PORTS, depsSummary(deposits))!;
    // Window trading pnl = £20 on capital 2000 + 220 = 2220.
    expect(cardPct).toBeCloseTo((20 / 2220) * 100, 10);
    // Last-day trading pnl = £5 on capital 2265 + (−30) = 2235.
    expect(summary.real.pnl).toBeCloseTo(5, 10);
    expect(summary.real.pct).toBeCloseTo((5 / 2235) * 100, 10);

  });

  it("splitting one large deposit into many small events leaves every pnl unchanged", () => {
    // Same £500 net inflow on 2026-07-02 delivered three ways:
    // (a) one £500 event, (b) five £100 events on the same date,
    // (c) £100 + £150 + £200 + £50 spread across the day. Every
    // per-day chart pnl, the card pct, and the tile pnl must be bit-
    // identical because the daily aggregation only cares about the
    // net flow within (prev, curr].
    const rows: Array<[string, number]> = [
      ["2026-07-01", 1000],
      ["2026-07-02", 1520], // +£20 trading + £500 deposit
    ];
    const arrangements: Array<Array<[string, number]>> = [
      [["2026-07-02", 500]],
      Array.from({ length: 5 }, () => ["2026-07-02", 100] as [string, number]),
      [
        ["2026-07-02", 100],
        ["2026-07-02", 150],
        ["2026-07-02", 200],
        ["2026-07-02", 50],
      ],
    ];

    const golden = computeDailyEquityChanges(eq(rows), depsChart(arrangements[0]));
    for (const arr of arrangements.slice(1)) {
      const daily = computeDailyEquityChanges(eq(rows), depsChart(arr));
      expect(daily).toEqual(golden);
    }

    // Card and summary must also agree across arrangements.
    const cardBase = computeCardRangePct(spark(rows), depsCard(arrangements[0]), false)!;
    const summaryBase = computeModeSummary(series(rows), PORTS, depsSummary(arrangements[0]))!;
    for (const arr of arrangements.slice(1)) {
      expect(computeCardRangePct(spark(rows), depsCard(arr), false)!).toBeCloseTo(cardBase, 10);
      const s = computeModeSummary(series(rows), PORTS, depsSummary(arr))!;
      expect(s.real.pnl).toBeCloseTo(summaryBase.real.pnl, 10);
      expect(s.real.pct).toBeCloseTo(summaryBase.real.pct, 10);
    }
    // And the golden trading pnl really is £20 (deposits stripped).
    expect(golden[0].pnl).toBeCloseTo(20, 10);
  });

  it("deposits dated on/before the first snapshot are baked into baseline and NOT re-netted", () => {
    // The £100 opening balance and £200 seed both fall on/before the
    // first snapshot (2026-07-01) so they must NOT be subtracted from
    // day 2's pct. Only the £250 mid-window top-up should be netted.
    const rows: Array<[string, number]> = [
      ["2026-07-01", 1000],
      ["2026-07-02", 1260], // +£10 trading + £250 deposit
    ];
    const deposits: Array<[string, number]> = [
      ["2026-06-15", 100], // pre-baseline, ignored
      ["2026-07-01", 200], // on baseline, ignored
      ["2026-07-02", 250], // in-window, netted
    ];
    const daily = computeDailyEquityChanges(eq(rows), depsChart(deposits));
    expect(daily[0].netFlow).toBe(250);
    expect(daily[0].pnl).toBeCloseTo(10, 10);
    expect(daily[0].pct).toBeCloseTo((10 / 1000) * 100, 10);

    // Card and summary parity.
    const cardPct = computeCardRangePct(spark(rows), depsCard(deposits), false)!;
    const summary = computeModeSummary(series(rows), PORTS, depsSummary(deposits))!;
    // Capital-adjusted denom = 1000 + 250 = 1250 (pre-baseline flows
    // never re-enter cumulative).
    expect(cardPct).toBeCloseTo((10 / 1250) * 100, 10);
    expect(summary.real.pct).toBeCloseTo((10 / 1250) * 100, 10);
  });

  it("pathological large-deposit day cannot masquerade as a huge trading gain", () => {
    // Regression: the Balanced-sim scenario. £1,000 baseline, £999,000
    // deposit mid-window with only £11 trading gain across the whole
    // month. The daily chart bar for the deposit day, the trailing
    // card pct, and the mode-summary tile must all reject the
    // apparent +99,000% gain and report the trading residual instead.
    const rows: Array<[string, number]> = [
      ["2026-07-01", 1000],
      ["2026-07-15", 1_000_005], // +£5 trading + £999,000 deposit
      ["2026-07-30", 1_000_011], // +£6 more trading
    ];
    const deposits: Array<[string, number]> = [["2026-07-15", 999_000]];

    const daily = computeDailyEquityChanges(eq(rows), depsChart(deposits));
    // Deposit day: raw jumped by 999,005 but trading pnl is £5.
    expect(daily[0].rawDelta).toBeCloseTo(999_005, 6);
    expect(daily[0].netFlow).toBe(999_000);
    expect(daily[0].pnl).toBeCloseTo(5, 6);
    expect(daily[0].pct).toBeCloseTo((5 / 1000) * 100, 6);
    // Post-deposit day: no flow, £6 trading on £1,000,005 base.
    expect(daily[1].netFlow).toBe(0);
    expect(daily[1].pnl).toBeCloseTo(6, 6);

    // Trailing card badge and tile: £11 trading on £1,000,000 capital.
    const cardPct = computeCardRangePct(spark(rows), depsCard(deposits), false)!;
    const summary = computeModeSummary(series(rows), PORTS, depsSummary(deposits))!;
    expect(cardPct).toBeCloseTo((11 / 1_000_000) * 100, 6);
    expect(summary.real.pnl).toBeCloseTo(11, 6);
    expect(summary.real.pct).toBeCloseTo((11 / 1_000_000) * 100, 6);
    // And definitively NOT the raw +100000%-ish figure.
    expect(cardPct).toBeLessThan(1);
    expect(summary.real.pct).toBeLessThan(1);
  });
});
