// E2E: render the home dashboard's real-money equity tile "as of" multiple
// historical dates and confirm each date's totals come strictly from that
// date's stored snapshot — never bleeding forward or backward.
//
// The dashboard's tile uses the LAST row in `buildAllPortfoliosEquity`'s
// series. To simulate "viewing the dashboard on day X", we pass X as
// `today` and assert the tile reflects X's snapshot (or the most recent
// prior snapshot for that portfolio if X has none yet — never a phantom
// backfill from starting_cash).

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAllPortfoliosEquity,
  type PortfolioEquityInput,
  type EquitySnapshotInput,
} from "@/lib/all-portfolios-equity";
import { ModeSummaryTile } from "@/routes/index";

function computeTodaySummary(
  data: ReturnType<typeof buildAllPortfoliosEquity>,
) {
  const { series, portfolios } = data;
  if (series.length === 0 || portfolios.length === 0) return null;
  const hasModeValue = (row: Record<string, unknown>, real: boolean) =>
    portfolios.some((p) => {
      const isReal = p.mode === "live_prod";
      if (isReal !== real) return false;
      return Number.isFinite(Number(row[p.id]));
    });
  const sumMode = (row: Record<string, unknown>, real: boolean) =>
    portfolios.reduce((sum, p) => {
      const isReal = p.mode === "live_prod";
      if (isReal !== real) return sum;
      const v = Number(row[p.id]);
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
  const modeSummary = (real: boolean) => {
    const rows = series.filter((r) =>
      hasModeValue(r as Record<string, unknown>, real),
    ) as Array<Record<string, unknown>>;
    const last = rows[rows.length - 1];
    if (!last) return { now: 0, pnl: 0, pct: 0 };
    const prev = rows.length > 1 ? rows[rows.length - 2] : last;
    const now = sumMode(last, real);
    const previous = sumMode(prev, real);
    return {
      now,
      pnl: now - previous,
      pct: previous > 0 ? ((now - previous) / previous) * 100 : 0,
    };
  };
  return {
    real: {
      ...modeSummary(true),
      count: portfolios.filter((p) => p.mode === "live_prod").length,
    },
    sim: {
      ...modeSummary(false),
      count: portfolios.filter((p) => p.mode !== "live_prod").length,
    },
  };
}

function renderReal(summary: NonNullable<ReturnType<typeof computeTodaySummary>>) {
  return renderToStaticMarkup(
    <ModeSummaryTile
      label="Real-money equity"
      sublabel="REAL · live Saxo"
      tone="real"
      money={summary.real.now}
      pnl={summary.real.pnl}
      pct={summary.real.pct}
      count={summary.real.count}
    />,
  );
}

function numericTokens(html: string): number[] {
  return (html.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((t) => Number(t.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

const LIVE = "11111111-1111-4111-8111-111111111111";
const SIM = "22222222-2222-4222-8222-222222222222";

// Historical fixture: 5 consecutive days of stored snapshots. The real
// portfolio wasn't funded until day 3. The sim portfolio ran the whole time.
const PORTFOLIOS: PortfolioEquityInput[] = [
  {
    id: LIVE,
    name: "Live Saxo",
    currency: "GBP",
    mode: "live_prod",
    starting_cash: 300,
    current_cash: 320.5,
  },
  {
    id: SIM,
    name: "Sim A",
    currency: "GBP",
    mode: "paper",
    starting_cash: 1000,
    current_cash: 1080,
  },
];

const SNAPSHOTS: EquitySnapshotInput[] = [
  // Sim runs every day.
  { portfolio_id: SIM, snapshot_date: "2026-07-20", total_value: 1000 },
  { portfolio_id: SIM, snapshot_date: "2026-07-21", total_value: 1010 },
  { portfolio_id: SIM, snapshot_date: "2026-07-22", total_value: 1030 },
  { portfolio_id: SIM, snapshot_date: "2026-07-23", total_value: 1050 },
  { portfolio_id: SIM, snapshot_date: "2026-07-24", total_value: 1080 },
  // Live funded on day 3 (2026-07-22) with £300, then grew.
  { portfolio_id: LIVE, snapshot_date: "2026-07-22", total_value: 300 },
  { portfolio_id: LIVE, snapshot_date: "2026-07-23", total_value: 300.46 },
  { portfolio_id: LIVE, snapshot_date: "2026-07-24", total_value: 320.5 },
];

describe("home dashboard real-money equity across historical dates (e2e)", () => {
  const cases: Array<{
    today: string;
    expectedNow: number;
    expectedPnl: number;
    expectedCount: number;
    // Numbers that must NOT appear as tokens in the rendered HTML for this
    // date — i.e. other dates' totals or sim totals.
    forbidden: number[];
  }> = [
    // Before the live portfolio exists — it isn't in the DB yet, so the
    // tile shows £0 and no real-money portfolios. Must NOT preview any
    // future real total or sim totals.
    {
      today: "2026-07-20",
      expectedNow: 0,
      expectedPnl: 0,
      expectedCount: 0,
      forbidden: [300, 320, 1010, 1030, 1050, 1080],
    },
    {
      today: "2026-07-21",
      expectedNow: 0,
      expectedPnl: 0,
      expectedCount: 0,
      forbidden: [300, 320, 1030, 1050, 1080],
    },
    // First live snapshot — £300, zero PnL (only one point).
    {
      today: "2026-07-22",
      expectedNow: 300,
      expectedPnl: 0,
      expectedCount: 1,
      forbidden: [320, 1050, 1080],
    },
    // Day 4 — 300.46 vs 300 previous.
    {
      today: "2026-07-23",
      expectedNow: 300.46,
      expectedPnl: 0.46,
      expectedCount: 1,
      forbidden: [320, 1050, 1080],
    },
    // Day 5 — 320.5 vs 300.46 previous.
    {
      today: "2026-07-24",
      expectedNow: 320.5,
      expectedPnl: 20.04,
      expectedCount: 1,
      forbidden: [1080],
    },
  ];

  // Simulate the DB as of `today`: only portfolios that have any snapshot
  // on/before that date are in the DB, and only their snapshots up to that
  // date exist. This mirrors what the dashboard would actually fetch when
  // rendered on that historical date.
  function stateAsOf(today: string) {
    const snapshots = SNAPSHOTS.filter((s) => s.snapshot_date <= today);
    const existingIds = new Set(snapshots.map((s) => s.portfolio_id));
    const portfolios = PORTFOLIOS.filter((p) => existingIds.has(p.id));
    return { portfolios, snapshots };
  }

  for (const c of cases) {
    it(`viewing on ${c.today}: shows only that date's real-money snapshot`, () => {
      const { portfolios, snapshots } = stateAsOf(c.today);
      const data = buildAllPortfoliosEquity({
        portfolios,
        snapshots,
        today: c.today,
      });
      const summary = computeTodaySummary(data);
      const real = summary?.real ?? { now: 0, pnl: 0, pct: 0, count: 0 };
      expect(real.now).toBeCloseTo(c.expectedNow, 10);
      expect(real.pnl).toBeCloseTo(c.expectedPnl, 10);
      expect(real.count).toBe(c.expectedCount);

      const html = renderReal({
        real,
        sim: summary?.sim ?? { now: 0, pnl: 0, pct: 0, count: 0 },
      });
      const nums = numericTokens(html);
      for (const forbidden of c.forbidden) {
        expect(
          nums,
          `date ${c.today}: rendered HTML must not contain ${forbidden}`,
        ).not.toContain(forbidden);
      }
    });
  }

  it("re-rendering across all dates yields the exact per-date snapshot sequence (no cross-date bleed)", () => {
    const timeline = cases.map((c) => {
      const { portfolios, snapshots } = stateAsOf(c.today);
      const data = buildAllPortfoliosEquity({
        portfolios,
        snapshots,
        today: c.today,
      });
      const summary = computeTodaySummary(data);
      return summary?.real.now ?? 0;
    });
    expect(timeline).toEqual([0, 0, 300, 300.46, 320.5]);
  });
});
