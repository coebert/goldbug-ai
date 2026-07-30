// End-to-end test: simulate a broker cash sync writing into equity_snapshots
// via the real `writeCashSyncSnapshot` code path, then verify the home
// dashboard's real-money equity tile totals match the latest stored cash +
// holdings from those snapshots.
//
// Pipeline exercised:
//   1. `writeCashSyncSnapshot` (production code) against a fake in-memory
//      equity_snapshots table — simulating the Saxo cash sync writing a
//      snapshot for today.
//   2. `buildAllPortfoliosEquity` — the pure selector the dashboard uses.
//   3. The `todaySummary` reducer inlined in src/routes/index.tsx (mirrored
//      here — keep in lockstep with the route).
//   4. The real `<ModeSummaryTile>` rendered via react-dom/server.
//
// Then asserts the rendered "Real-money equity" tile shows exactly
// cash + holdings from the most recent stored snapshot.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  writeCashSyncSnapshot,
  type CashSyncSnapshotClient,
} from "@/lib/live-cash-sync.server";
import {
  buildAllPortfoliosEquity,
  type PortfolioEquityInput,
  type EquitySnapshotInput,
} from "@/lib/all-portfolios-equity";
import { ModeSummaryTile } from "@/routes/index";

// --- Fake equity_snapshots table (matches CashSyncSnapshotClient shape) ----

type Row = {
  id: string;
  portfolio_id: string;
  snapshot_date: string;
  cash: number;
  holdings_value: number;
  total_value: number | null;
};

function makeFakeClient(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  let idCounter = initial.length + 1;
  const client: CashSyncSnapshotClient = {
    from(table) {
      if (table !== "equity_snapshots") throw new Error(`unexpected ${table}`);
      return {
        select(_cols: string) {
          return {
            eq(_c: "portfolio_id", pid: string) {
              return {
                eq(_c2: "snapshot_date", date: string) {
                  return {
                    async maybeSingle() {
                      const m = rows.find(
                        (r) => r.portfolio_id === pid && r.snapshot_date === date,
                      );
                      return {
                        data: m ? { id: m.id, total_value: m.total_value } : null,
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        },
        update(patch) {
          return {
            async eq(_c: "id", id: string) {
              const i = rows.findIndex((r) => r.id === id);
              if (i < 0) return { error: { message: "not found" } };
              rows[i] = { ...rows[i], ...patch };
              return { error: null };
            },
          };
        },
        async insert(row) {
          rows.push({ id: `r${idCounter++}`, ...row });
          return { error: null };
        },
      };
    },
  };
  return { client, rows };
}

// --- Mirror of `todaySummary` in src/routes/index.tsx ----------------------

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
  const real = modeSummary(true);
  return {
    real: {
      ...real,
      count: portfolios.filter((p) => p.mode === "live_prod").length,
    },
  };
}

function numericTokens(html: string): number[] {
  return (html.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((t) => Number(t.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

const LIVE_PID = "11111111-1111-4111-8111-111111111111";

describe("broker cash sync → dashboard real-money equity (e2e)", () => {
  it("dashboard tile totals equal latest stored cash + holdings after sync", async () => {
    const { client, rows } = makeFakeClient();

    // Day 1: user funds account with £300, no holdings yet.
    const r1 = await writeCashSyncSnapshot(client, {
      portfolioId: LIVE_PID,
      snapshotDate: "2026-07-22",
      cash: 300,
      holdingsValue: 0,
    });
    expect(r1.action).toBe("inserted");

    // Day 2: AI buys instruments; broker sync now sees £124.60 cash and
    // £175.86 of holdings. This should UPDATE the day-2 row on repeated
    // syncs (which happen every 15 minutes) and never duplicate it.
    await writeCashSyncSnapshot(client, {
      portfolioId: LIVE_PID,
      snapshotDate: "2026-07-23",
      cash: 200,
      holdingsValue: 100,
    });
    const r2b = await writeCashSyncSnapshot(client, {
      portfolioId: LIVE_PID,
      snapshotDate: "2026-07-23",
      cash: 124.6,
      holdingsValue: 175.86,
    });
    expect(r2b.action).toBe("updated");

    // Sanity: exactly two rows, one per date.
    expect(rows).toHaveLength(2);
    const day2 = rows.find((r) => r.snapshot_date === "2026-07-23")!;
    expect(day2.cash).toBe(124.6);
    expect(day2.holdings_value).toBe(175.86);
    expect(day2.total_value).toBeCloseTo(300.46, 10);

    // --- Feed the stored snapshots into the dashboard selector ------------
    const portfolios: PortfolioEquityInput[] = [
      {
        id: LIVE_PID,
        name: "Live Saxo",
        currency: "GBP",
        mode: "live_prod",
        starting_cash: 300,
        current_cash: day2.cash,
      },
    ];
    const snapshots: EquitySnapshotInput[] = rows.map((r) => ({
      portfolio_id: r.portfolio_id,
      snapshot_date: r.snapshot_date,
      total_value: r.total_value ?? 0,
    }));

    const data = buildAllPortfoliosEquity({
      portfolios,
      snapshots,
      today: "2026-07-23",
    });
    const summary = computeTodaySummary(data)!;

    // Latest tile value = today's cash + holdings from the stored snapshot.
    expect(summary.real.now).toBeCloseTo(day2.cash + day2.holdings_value, 10);
    // Day-over-day PnL = today's total - yesterday's total (£300).
    expect(summary.real.pnl).toBeCloseTo(0.46, 10);
    expect(summary.real.count).toBe(1);

    // --- Render the real tile and verify the numbers appear ---------------
    const html = renderToStaticMarkup(
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
    expect(html).toContain("Real-money equity");
    expect(html).toContain("REAL · live Saxo · 1 portfolio");
    const nums = numericTokens(html);
    // Rendered whole-pound figure of today's cash + holdings must be present.
    expect(nums).toContain(300);
    // Must NOT show cash alone (124) or holdings alone (175) as the total.
    expect(nums).not.toContain(124);
    expect(nums).not.toContain(175);
  });

  it("repeated intra-day syncs keep the tile in sync with the latest broker cash", async () => {
    const { client, rows } = makeFakeClient();

    // Day 1 baseline.
    await writeCashSyncSnapshot(client, {
      portfolioId: LIVE_PID, snapshotDate: "2026-07-22", cash: 300, holdingsValue: 0,
    });
    // Day 2, three successive syncs as prices move.
    await writeCashSyncSnapshot(client, {
      portfolioId: LIVE_PID, snapshotDate: "2026-07-23", cash: 100, holdingsValue: 210,
    });
    await writeCashSyncSnapshot(client, {
      portfolioId: LIVE_PID, snapshotDate: "2026-07-23", cash: 100, holdingsValue: 215,
    });
    await writeCashSyncSnapshot(client, {
      portfolioId: LIVE_PID, snapshotDate: "2026-07-23", cash: 100, holdingsValue: 220.5,
    });

    // No duplicates for day 2.
    expect(rows.filter((r) => r.snapshot_date === "2026-07-23")).toHaveLength(1);

    const portfolios: PortfolioEquityInput[] = [
      {
        id: LIVE_PID,
        name: "Live Saxo",
        currency: "GBP",
        mode: "live_prod",
        starting_cash: 300,
        current_cash: 100,
      },
    ];
    const snapshots: EquitySnapshotInput[] = rows.map((r) => ({
      portfolio_id: r.portfolio_id,
      snapshot_date: r.snapshot_date,
      total_value: r.total_value ?? 0,
    }));
    const data = buildAllPortfoliosEquity({
      portfolios, snapshots, today: "2026-07-23",
    });
    const summary = computeTodaySummary(data)!;

    // Tile shows the LATEST sync (100 + 220.5 = 320.5), not any earlier value.
    expect(summary.real.now).toBeCloseTo(320.5, 10);
    expect(summary.real.pnl).toBeCloseTo(20.5, 10);

    const html = renderToStaticMarkup(
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
    // Positive tone applied for a gain.
    expect(html).toContain("text-success");
    // Neither of the earlier intra-day totals should appear as the headline.
    const nums = numericTokens(html);
    expect(nums).not.toContain(310);
    expect(nums).not.toContain(315);
  });
});
