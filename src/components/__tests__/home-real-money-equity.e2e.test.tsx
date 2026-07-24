// End-to-end test for the home dashboard's real-money equity tile.
//
// Exercises the full pipeline the dashboard uses:
//   1. Simulated stored rows (portfolios + equity_snapshots) — the exact
//      shape that `writeCashSyncSnapshot` persists after the live cash
//      baseline fix.
//   2. `buildAllPortfoliosEquity` — the pure selector that feeds
//      `useQuery(["all-portfolios-equity"])` in `src/routes/index.tsx`.
//   3. The same `todaySummary` reducer inlined in `src/routes/index.tsx`
//      (kept in lockstep here; if the route reducer changes, this test
//      must be updated).
//   4. The real `<ModeSummaryTile>` React component from the route,
//      rendered via `react-dom/server` (no jsdom needed).
//
// Then asserts the rendered "Real-money equity" markup shows the totals
// derived directly from the stored snapshots — NOT from `starting_cash`
// backfill, NOT summed with the simulated portfolios.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAllPortfoliosEquity,
  type PortfolioEquityInput,
  type EquitySnapshotInput,
} from "@/lib/all-portfolios-equity";
import { ModeSummaryTile } from "@/routes/index";

// Mirror of the `todaySummary` useMemo body in src/routes/index.tsx.
function computeTodaySummary(
  data: ReturnType<typeof buildAllPortfoliosEquity>,
) {
  const series = data.series;
  const portfolios = data.portfolios;
  if (series.length === 0 || portfolios.length === 0) return null;
  const hasModeValue = (row: Record<string, unknown>, real: boolean) =>
    portfolios.some((p) => {
      const isReal = p.mode === "live_prod";
      if (isReal !== real) return false;
      const v = Number(row[p.id]);
      return Number.isFinite(v);
    });
  const sumMode = (row: Record<string, unknown>, real: boolean) =>
    portfolios.reduce((sum, p) => {
      const isReal = p.mode === "live_prod";
      if (isReal !== real) return sum;
      const value = Number(row[p.id]);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
  const modeSummary = (real: boolean) => {
    const rows = series.filter((row) =>
      hasModeValue(row as Record<string, unknown>, real),
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
  const sim = modeSummary(false);
  const real = modeSummary(true);
  return {
    sim: {
      ...sim,
      count: portfolios.filter((p) => p.mode !== "live_prod").length,
    },
    real: {
      ...real,
      count: portfolios.filter((p) => p.mode === "live_prod").length,
    },
  };
}

function renderRealTile(summary: ReturnType<typeof computeTodaySummary>) {
  if (!summary) throw new Error("no summary");
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

// Strip currency symbols / non-breaking spaces / thousand separators so we
// can assert numeric equality independent of locale nuances.
function numericTokens(html: string): number[] {
  return (html.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((t) => Number(t.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

describe("home dashboard real-money equity (e2e)", () => {
  it("displays totals equal to the stored snapshots after live cash baseline handling", () => {
    // Baseline the user actually deposited into Saxo. After the fix,
    // `writeCashSyncSnapshot` records this exact value on the day the
    // account was funded, and `starting_cash` stays anchored to £300.
    const portfolios: PortfolioEquityInput[] = [
      {
        id: "sim-a",
        name: "Sim A",
        currency: "GBP",
        mode: "paper",
        starting_cash: 1000,
        current_cash: 1040,
      },
      {
        id: "live-1",
        name: "Live Saxo",
        currency: "GBP",
        mode: "live_prod",
        starting_cash: 300,
        current_cash: 300,
      },
    ];

    // Two consecutive daily snapshots for the live portfolio. Before the
    // baseline fix, an earlier bug would have back-filled a phantom value
    // for dates the live portfolio did not exist, dragging the tile.
    const snapshots: EquitySnapshotInput[] = [
      { portfolio_id: "sim-a", snapshot_date: "2026-07-22", total_value: 1020 },
      { portfolio_id: "sim-a", snapshot_date: "2026-07-23", total_value: 1040 },
      { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 300 },
      { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: 300 },
    ];

    const data = buildAllPortfoliosEquity({
      portfolios,
      snapshots,
      today: "2026-07-23",
    });
    const summary = computeTodaySummary(data);
    expect(summary).not.toBeNull();
    expect(summary!.real.now).toBe(300);
    expect(summary!.real.pnl).toBe(0);
    expect(summary!.real.count).toBe(1);
    // Real must NOT include the simulated portfolio.
    expect(summary!.real.now).not.toBe(1340);

    const html = renderRealTile(summary);
    expect(html).toContain("Real-money equity");
    expect(html).toContain("REAL · live Saxo · 1 portfolio");
    const nums = numericTokens(html);
    // Rendered money value (300) must be present; nothing summed with sim.
    expect(nums).toContain(300);
    expect(nums).not.toContain(1340);
    expect(nums).not.toContain(1040);
  });

  it("reflects a real-money gain when today's snapshot exceeds yesterday's", () => {
    const portfolios: PortfolioEquityInput[] = [
      {
        id: "live-1",
        name: "Live Saxo",
        currency: "GBP",
        mode: "live_prod",
        starting_cash: 300,
        current_cash: 315,
      },
    ];
    const snapshots: EquitySnapshotInput[] = [
      { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 300 },
      { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: 315 },
    ];
    const data = buildAllPortfoliosEquity({
      portfolios,
      snapshots,
      today: "2026-07-23",
    });
    const summary = computeTodaySummary(data)!;
    expect(summary.real.now).toBe(315);
    expect(summary.real.pnl).toBe(15);
    expect(summary.real.pct).toBeCloseTo(5, 5);

    const html = renderRealTile(summary);
    expect(html).toContain("+5.00%");
    // Positive tone class applied.
    expect(html).toContain("text-emerald-400");
  });

  it("shows the empty state when no real-money portfolios exist", () => {
    const portfolios: PortfolioEquityInput[] = [
      {
        id: "sim-a",
        name: "Sim A",
        currency: "GBP",
        mode: "paper",
        starting_cash: 1000,
        current_cash: 1040,
      },
    ];
    const snapshots: EquitySnapshotInput[] = [
      { portfolio_id: "sim-a", snapshot_date: "2026-07-23", total_value: 1040 },
    ];
    const data = buildAllPortfoliosEquity({
      portfolios,
      snapshots,
      today: "2026-07-23",
    });
    const summary = computeTodaySummary(data)!;
    expect(summary.real.count).toBe(0);

    const html = renderRealTile(summary);
    expect(html).toContain("No real-money portfolios");
    // Empty state must not render a currency figure at all.
    expect(numericTokens(html)).not.toContain(1040);
  });
});
