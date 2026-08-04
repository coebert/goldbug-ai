// CI parity test: the daily equity % change values persisted server-
// side (via `backfillPortfolioDailyChanges` → `daily_equity_changes`
// table) MUST match, per day and to display precision, the values
// the UI actually renders in `<DailyEquityChangesCard />`.
//
// Why this test exists:
//   Historically the server and the UI have derived percentages
//   independently. The Balanced-sim +1101% regression showed how a
//   drift between the two paths hides for weeks because the stored
//   backfill values look plausible and the chart looks plausible —
//   only a same-fixture comparison catches the mismatch.
//
// What it locks in:
//   1. Both paths call `computeDailyEquityChanges` and get identical
//      { date, pct, pnl, netFlow } rows.
//   2. The card's rendered chart bar for each day equals the server
//      row's pct to the same 2-decimal precision the tooltip shows.
//   3. Deposits/withdrawals never bleed into pct on either side, even
//      when the deposit is 1000× the baseline (the £1k → £1M case).
//
// The test intentionally uses deposit-heavy fixtures — pure trading
// days are already covered by daily-equity-changes.test.ts.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  computeDailyEquityChanges,
  type DepositLite,
  type EquitySnapshotLite,
} from "@/lib/daily-equity-changes";
import { DailyEquityChangesCard } from "@/components/daily-equity-changes-card";

// ---------------------------------------------------------------
// Recharts is a client-only SVG renderer; jsdom cannot measure its
// ResponsiveContainer. We stub it to a data-attribute-carrying div so
// the test can read the exact `chartData` prop the card fed the chart.
// ---------------------------------------------------------------
vi.mock("recharts", () => {
  const Passthrough = ({ children }: { children?: unknown }) => children as never;
  return {
    ResponsiveContainer: Passthrough,
    BarChart: ({ data, children }: { data: unknown; children?: unknown }) => (
      <div data-testid="chart-data" data-payload={JSON.stringify(data)}>
        {children as never}
      </div>
    ),
    Bar: Passthrough,
    Cell: () => null,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    ReferenceLine: () => null,
    Tooltip: () => null,
  };
});

// ---------------------------------------------------------------
// Server-side backfill payload builder — mirrors
// backfillPortfolioDailyChanges exactly (minus DB I/O).
// ---------------------------------------------------------------
function serverDerivedRows(equity: EquitySnapshotLite[], deposits: DepositLite[]) {
  return computeDailyEquityChanges(equity, deposits).map((c) => ({
    change_date: c.date,
    prev_date: c.prevDate,
    prev_equity: c.prevEquity,
    equity: c.equity,
    net_flow: c.netFlow,
    pnl: c.pnl,
    pct: c.pct,
  }));
}

// ---------------------------------------------------------------
// UI extraction — render the card and read the `data` payload that
// reached the chart plus the human-visible "Best/Worst" stats.
// ---------------------------------------------------------------
type ChartRow = {
  date: string;
  label: string;
  pct: number;
  pnl: number;
  equity: number;
  prevEquity: number;
  netFlow: number;
};

function uiRenderedRows(fixture: { equity: EquitySnapshotLite[]; deposits: DepositLite[] }): {
  chart: ChartRow[];
  best?: string;
  worst?: string;
} {
  const html = renderToStaticMarkup(
    <DailyEquityChangesCard equity={fixture.equity} deposits={fixture.deposits} currency="GBP" />,
  );
  // Parse without a DOM: the test runs under the node env. The mocked
  // BarChart wraps its data in a JSON-encoded `data-payload` attribute
  // that survives static markup verbatim (Recharts is stubbed above).
  const payloadMatch = html.match(/data-payload="([^"]*)"/);
  const decoded = payloadMatch
    ? payloadMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
    : "[]";
  const chart: ChartRow[] = JSON.parse(decoded);

  // Best/Worst stat values sit inside <div class="font-display …">.
  const stats = Array.from(
    html.matchAll(/<div class="[^"]*font-display[^"]*"[^>]*>([^<]*)<\/div>/g),
  ).map((m) => (m[1] ?? "").trim());
  return { chart, best: stats[2], worst: stats[3] };
}

// ---------------------------------------------------------------
// Deposit-heavy fixtures. Each covers a scenario that has historically
// produced UI/server drift.
// ---------------------------------------------------------------
type Fixture = {
  name: string;
  equity: EquitySnapshotLite[];
  deposits: DepositLite[];
};

const FIXTURES: Fixture[] = [
  {
    // The literal Balanced-sim regression: €1k baseline, €999k deposit
    // mid-week, then €11k trading gain. Correct daily pct on the
    // deposit day is 0%, on the trading day ≈ +1.1%.
    name: "million-euro-deposit-then-trading-gain",
    equity: [
      { snapshot_date: "2026-07-13", total_value: 1_000 },
      { snapshot_date: "2026-07-14", total_value: 1_000_000 },
      { snapshot_date: "2026-07-15", total_value: 1_000_500 },
      { snapshot_date: "2026-07-16", total_value: 1_011_000 },
    ],
    deposits: [{ date: "2026-07-14", amount: 999_000 }],
  },
  {
    // Multiple deposits + withdrawals interleaved with trading. Sim
    // fund events land at midday but are dated to the day.
    name: "multi-deposit-multi-withdrawal-interleaved",
    equity: [
      { snapshot_date: "2026-06-01", total_value: 10_000 },
      { snapshot_date: "2026-06-02", total_value: 15_100 }, // +5000 dep + 100 pnl
      { snapshot_date: "2026-06-03", total_value: 14_950 }, // -150 pnl
      { snapshot_date: "2026-06-04", total_value: 12_950 }, // -2000 wd
      { snapshot_date: "2026-06-05", total_value: 13_200 }, // +250 pnl
      { snapshot_date: "2026-06-06", total_value: 20_300 }, // +7000 dep + 100 pnl
    ],
    deposits: [
      { date: "2026-06-02", amount: 5_000 },
      { date: "2026-06-04", amount: -2_000 },
      { date: "2026-06-06", amount: 7_000 },
    ],
  },
  {
    // Pure cash-flow days with zero trading pnl must render as 0.00%.
    name: "pure-deposit-only-days",
    equity: [
      { snapshot_date: "2026-05-10", total_value: 500 },
      { snapshot_date: "2026-05-11", total_value: 700 },
      { snapshot_date: "2026-05-12", total_value: 1_000 },
    ],
    deposits: [
      { date: "2026-05-11", amount: 200 },
      { date: "2026-05-12", amount: 300 },
    ],
  },
  {
    // Same-day deposit dated on the prev anchor: must be already baked
    // into the baseline and NOT re-subtracted. Left-exclusive window.
    name: "deposit-on-anchor-day",
    equity: [
      { snapshot_date: "2026-04-01", total_value: 1_200 }, // includes 200 dep
      { snapshot_date: "2026-04-02", total_value: 1_260 }, // +60 pnl
    ],
    deposits: [{ date: "2026-04-01", amount: 200 }],
  },
  {
    // Real-money-flavoured: small starting pot, one large user top-up,
    // then several trading days including a losing day.
    name: "real-money-topup-then-losing-day",
    equity: [
      { snapshot_date: "2026-03-20", total_value: 100 },
      { snapshot_date: "2026-03-21", total_value: 300 }, // +200 dep
      { snapshot_date: "2026-03-22", total_value: 315 }, // +15 pnl
      { snapshot_date: "2026-03-23", total_value: 302 }, // -13 pnl
      { snapshot_date: "2026-03-24", total_value: 306.5 }, // +4.5 pnl
    ],
    deposits: [{ date: "2026-03-21", amount: 200 }],
  },
];

describe("CI parity — server vs UI daily equity % change", () => {
  for (const f of FIXTURES) {
    it(`${f.name}: server and UI produce identical per-day pct/pnl/netFlow`, () => {
      const server = serverDerivedRows(f.equity, f.deposits);
      const { chart } = uiRenderedRows(f);

      // Same day set, same order.
      expect(chart.map((r) => r.date)).toEqual(server.map((r) => r.change_date));

      for (let i = 0; i < server.length; i++) {
        const s = server[i];
        const u = chart[i];

        // Structural payload — must be bit-exact.
        expect(u.netFlow).toBe(s.net_flow);
        expect(u.equity).toBe(s.equity);
        expect(u.prevEquity).toBe(s.prev_equity);
        expect(u.pnl).toBeCloseTo(s.pnl, 8);

        // Pct: the UI rounds to 4dp for the chart payload and to 2dp
        // in the tooltip. Both must equal the server value at that
        // precision — the tooltip precision is the user-visible one.
        expect(u.pct).toBeCloseTo(Number(s.pct.toFixed(4)), 8);
        expect(Number(u.pct.toFixed(2))).toBe(Number(s.pct.toFixed(2)));
      }
    });

    it(`${f.name}: deposits never bleed into pct on either surface`, () => {
      const server = serverDerivedRows(f.equity, f.deposits);
      const { chart } = uiRenderedRows(f);

      for (let i = 0; i < server.length; i++) {
        const s = server[i];
        const u = chart[i];
        // For every day whose only movement is a cash flow (rawDelta
        // exactly equals netFlow), both surfaces must report 0.
        const rawDelta = s.equity - s.prev_equity;
        if (Math.abs(rawDelta - s.net_flow) < 1e-9) {
          expect(s.pct).toBe(0);
          expect(u.pct).toBe(0);
          expect(s.pnl).toBe(0);
          expect(u.pnl).toBe(0);
        }
      }
    });
  }

  it("Best/Worst summary stats reflect the same server-derived pct values", () => {
    const f = FIXTURES[1]; // multi-deposit-multi-withdrawal-interleaved
    const server = serverDerivedRows(f.equity, f.deposits);
    const { best, worst } = uiRenderedRows(f);

    const bestPct = server.reduce((m, r) => (r.pct > m.pct ? r : m), server[0]).pct;
    const worstPct = server.reduce((m, r) => (r.pct < m.pct ? r : m), server[0]).pct;

    const fmt = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
    expect(best).toBe(fmt(bestPct));
    expect(worst).toBe(fmt(worstPct));
  });
});
