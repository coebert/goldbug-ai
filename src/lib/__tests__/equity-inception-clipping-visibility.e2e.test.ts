// E2E: portfolio equity must stay visible after inception clipping.
//
// Regression guard for the "High risk sim / Balanced risk sim show no data"
// bug: both sims carry snapshots dated before their `created_at` (seeded and
// backtest replays), and a naive clip wiped every row, leaving the cards with
// "No equity snapshots yet" and a 100%-cash reading. This test runs the real
// read path — per-portfolio clipToInception, then buildAllPortfoliosEquity —
// plus the self-healing backfill planner, and asserts both sims render points.

import { describe, expect, it } from "vitest";
import { buildAllPortfoliosEquity } from "../all-portfolios-equity";
import { clipToInception, portfolioInceptionDate } from "../portfolio-inception";
import { planMissingEquitySnapshots } from "../equity-snapshot-backfill";

const TODAY = "2026-07-31";

type Pf = {
  id: string;
  name: string;
  currency: string;
  mode: string;
  starting_cash: number;
  current_cash: number;
  created_at: string;
  live_activated_at: string | null;
};

const balanced: Pf = {
  id: "pf-balanced",
  name: "Balanced risk sim",
  currency: "EUR",
  mode: "live_sim",
  starting_cash: 10000,
  current_cash: 3200,
  created_at: "2026-07-20T09:00:00Z",
  live_activated_at: null,
};

const high: Pf = {
  id: "pf-high",
  name: "High risk sim",
  currency: "EUR",
  mode: "live_sim",
  starting_cash: 10000,
  current_cash: 1500,
  created_at: "2026-07-20T09:00:00Z",
  live_activated_at: null,
};

/** Snapshots dated entirely BEFORE created_at (backtest/seeded replay). */
function preInceptionSnapshots(portfolioId: string, base: number) {
  return ["2026-07-10", "2026-07-11", "2026-07-12"].map((d, i) => ({
    portfolio_id: portfolioId,
    snapshot_date: d,
    cash: 1000 + i,
    total_value: base + i * 25,
  }));
}

/** The production read path from src/lib/portfolios.functions.ts. */
function readEquity(portfolios: Pf[], snapshots: ReturnType<typeof preInceptionSnapshots>) {
  const byPid = new Map<string, typeof snapshots>();
  for (const s of snapshots) {
    const arr = byPid.get(s.portfolio_id) ?? [];
    arr.push(s);
    byPid.set(s.portfolio_id, arr);
  }
  const clipped = [...byPid.entries()].flatMap(([pid, rows]) => {
    const pf = portfolios.find((p) => p.id === pid)!;
    return clipToInception(rows, portfolioInceptionDate(pf), (r) => r.snapshot_date);
  });
  return { clipped, built: buildAllPortfoliosEquity({ portfolios, snapshots: clipped, today: TODAY }) };
}

describe("equity visibility after inception clipping (balanced + high risk sims)", () => {
  it("keeps every pre-inception row when clipping would wipe the whole series", () => {
    const snaps = [
      ...preInceptionSnapshots(balanced.id, 9800),
      ...preInceptionSnapshots(high.id, 10500),
    ];
    const { clipped, built } = readEquity([balanced, high], snaps);

    expect(clipped).toHaveLength(snaps.length);
    for (const pf of [balanced, high]) {
      const series = built.perPortfolioSeries[pf.id];
      expect(series, `${pf.name} must have a visible series`).toBeDefined();
      expect(series.length).toBeGreaterThan(0);
      expect(series.every((p) => Number.isFinite(p.value))).toBe(true);
    }
  });

  it("clips only the pre-inception prefix when post-inception rows exist", () => {
    const snaps = [
      ...preInceptionSnapshots(balanced.id, 9800),
      { portfolio_id: balanced.id, snapshot_date: "2026-07-25", cash: 3200, total_value: 10250 },
      ...preInceptionSnapshots(high.id, 10500),
      { portfolio_id: high.id, snapshot_date: "2026-07-26", cash: 1500, total_value: 11100 },
    ];
    const { built } = readEquity([balanced, high], snaps);

    expect(built.perPortfolioSeries[balanced.id].map((p) => p.date)).toEqual(["2026-07-25"]);
    expect(built.perPortfolioSeries[high.id].map((p) => p.date)).toEqual(["2026-07-26"]);
  });

  it("never leaves either sim empty: backfill plans today's row and the series stays non-empty", () => {
    // High risk sim has zero snapshots at all — the other empty-card path.
    const snaps = preInceptionSnapshots(balanced.id, 9800);

    const planned = planMissingEquitySnapshots({
      portfolios: [balanced, high].map((p) => ({
        id: p.id,
        current_cash: p.current_cash,
        inception: portfolioInceptionDate(p),
      })),
      snapshots: snaps,
      holdings: [
        { portfolio_id: high.id, symbol: "SPY", quantity: 20, avg_cost: 400 },
        { portfolio_id: balanced.id, symbol: "SPY", quantity: 10, avg_cost: 400 },
      ],
      prices: new Map([["SPY", 450]]),
      today: TODAY,
    });

    // Both sims get a fresh, mark-to-market row for today.
    expect(planned.filter((p) => p.reason === "today").map((p) => p.portfolio_id).sort()).toEqual(
      [balanced.id, high.id].sort(),
    );
    expect(planned.find((p) => p.portfolio_id === high.id && p.reason === "today")).toMatchObject({
      snapshot_date: TODAY,
      total_value: 1500 + 20 * 450,
    });

    const healed = [
      ...snaps,
      ...planned.map((p) => ({
        portfolio_id: p.portfolio_id,
        snapshot_date: p.snapshot_date,
        cash: p.cash,
        total_value: p.total_value,
      })),
    ];
    const { built } = readEquity([balanced, high], healed);

    for (const pf of [balanced, high]) {
      const series = built.perPortfolioSeries[pf.id];
      expect(series.length, `${pf.name} must not render empty`).toBeGreaterThan(0);
      expect(series.at(-1)!.date).toBe(TODAY);
      expect(series.at(-1)!.value).toBeGreaterThan(0);
    }
    // Sims must not be collapsed into one shared curve.
    expect(built.perPortfolioSeries[balanced.id].at(-1)!.value).not.toBe(
      built.perPortfolioSeries[high.id].at(-1)!.value,
    );
  });

  it("is idempotent: re-running the healed read plans nothing new", () => {
    const snaps = [
      ...preInceptionSnapshots(balanced.id, 9800),
      { portfolio_id: balanced.id, snapshot_date: TODAY, cash: 3200, total_value: 10250 },
      { portfolio_id: high.id, snapshot_date: TODAY, cash: 1500, total_value: 10500 },
    ];
    const planned = planMissingEquitySnapshots({
      portfolios: [balanced, high].map((p) => ({
        id: p.id,
        current_cash: p.current_cash,
        inception: portfolioInceptionDate(p),
      })),
      snapshots: snaps,
      holdings: [],
      prices: new Map(),
      today: TODAY,
    });
    expect(planned.filter((p) => p.reason === "today")).toEqual([]);

    const { built } = readEquity([balanced, high], snaps);
    expect(built.perPortfolioSeries[balanced.id].length).toBeGreaterThan(0);
    expect(built.perPortfolioSeries[high.id].length).toBeGreaterThan(0);
  });
});
