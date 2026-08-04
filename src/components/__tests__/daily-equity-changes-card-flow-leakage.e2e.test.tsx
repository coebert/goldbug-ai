// End-to-end regression: <DailyEquityChangesCard /> MUST refuse to render
// a chart whose per-day rows contain deposit/withdrawal leakage.
//
// Two complementary scenarios:
//
//   1. Happy path — fixture with real deposits AND withdrawals renders
//      cleanly, because `computeDailyEquityChanges` netts the flows.
//      Verifies the pnl bars actually reflect trading-only P&L, not the
//      raw cash swing.
//
//   2. Failure path — the compute function is mocked to return LEAKED
//      rows (pct derived from rawDelta instead of pnl on flow days), so
//      the card's `assertNoFlowLeakage` guard MUST throw before the
//      chart is drawn. A test-visible failure is the whole point: if
//      a future refactor removes the guard, this test flips.
//
// The failure surfaces as a thrown Error during render, which
// react-dom/server propagates synchronously — no error boundary is
// needed. We assert on the exact "flow leak" / "pct drift" diagnostic
// so we catch both branches of the guard (arithmetic and pct
// derivation).

import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  computeDailyEquityChanges as realCompute,
  type DailyEquityChange,
  type DepositLite,
  type EquitySnapshotLite,
} from "@/lib/daily-equity-changes";

// Stub Recharts (jsdom cannot render SVG in this env; the payload we
// care about is the `data` prop, which we capture as JSON).
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

// Mockable compute — production code paths use the real impl; the
// failure scenario swaps in a leaky implementation via vi.mocked().
vi.mock("@/lib/daily-equity-changes", async () => {
  const actual = await vi.importActual<typeof import("@/lib/daily-equity-changes")>(
    "@/lib/daily-equity-changes",
  );
  return {
    ...actual,
    // Wrapped so tests can override per-case with vi.mocked(...).mockImplementation.
    computeDailyEquityChanges: vi.fn(actual.computeDailyEquityChanges),
  };
});

// Imported AFTER vi.mock so the card sees the mocked module.
import { computeDailyEquityChanges } from "@/lib/daily-equity-changes";
import { DailyEquityChangesCard } from "@/components/daily-equity-changes-card";

const mockedCompute = vi.mocked(computeDailyEquityChanges);

afterEach(() => {
  mockedCompute.mockReset();
  // Default: use the real impl unless a test overrides.
  mockedCompute.mockImplementation(realCompute);
});

// -------------------------------------------------------------------
// Fixture: 5 daily snapshots with a mid-window deposit AND withdrawal.
//   Day 1: £1,000 (baseline)
//   Day 2: £1,010 (+£10 trading)
//   Day 3: £2,020 (+£1,000 deposit + £10 trading)
//   Day 4: £1,530 (-£500 withdrawal + £10 trading)
//   Day 5: £1,550 (+£20 trading)
// -------------------------------------------------------------------
const equity: EquitySnapshotLite[] = [
  { snapshot_date: "2026-06-01", total_value: 1_000 },
  { snapshot_date: "2026-06-02", total_value: 1_010 },
  { snapshot_date: "2026-06-03", total_value: 2_020 },
  { snapshot_date: "2026-06-04", total_value: 1_530 },
  { snapshot_date: "2026-06-05", total_value: 1_550 },
];
const deposits: DepositLite[] = [
  { date: "2026-06-03", amount: 1_000 }, // deposit
  { date: "2026-06-04", amount: -500 }, // withdrawal
];

function render() {
  return renderToStaticMarkup(
    <DailyEquityChangesCard equity={equity} deposits={deposits} currency="GBP" />,
  );
}

function readChart(html: string) {
  const m = html.match(/data-payload="([^"]*)"/);
  const decoded = m
    ? m[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
    : "[]";
  return JSON.parse(decoded) as Array<{
    date: string;
    pct: number;
    pnl: number;
    netFlow: number;
  }>;
}

describe("DailyEquityChangesCard: flow-leakage e2e", () => {
  it("happy path — renders with deposit + withdrawal flows netted out (no throw)", () => {
    // Sanity: real compute already netts flows, so nothing to leak.
    const html = render();
    const rows = readChart(html);

    // 4 transitions from 5 snapshots.
    expect(rows).toHaveLength(4);

    // Pull each day by date for readability.
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));

    // Day 2: pure trading +£10 → pct = 10/1000 = 1%.
    expect(byDate["2026-06-02"].pnl).toBeCloseTo(10, 6);
    expect(byDate["2026-06-02"].netFlow).toBe(0);
    expect(byDate["2026-06-02"].pct).toBeCloseTo(1, 4);

    // Day 3: rawDelta=+1010, deposit=+1000 ⇒ trading pnl = +10.
    expect(byDate["2026-06-03"].netFlow).toBe(1_000);
    expect(byDate["2026-06-03"].pnl).toBeCloseTo(10, 6);
    // pct MUST be derived from pnl only: 10 / 1010 ≈ 0.9901%.
    expect(byDate["2026-06-03"].pct).toBeCloseTo((10 / 1010) * 100, 3);

    // Day 4: rawDelta=-490, withdrawal=-500 ⇒ trading pnl = +10.
    expect(byDate["2026-06-04"].netFlow).toBe(-500);
    expect(byDate["2026-06-04"].pnl).toBeCloseTo(10, 6);
    expect(byDate["2026-06-04"].pct).toBeCloseTo((10 / 2020) * 100, 3);

    // Day 5: pure trading +£20.
    expect(byDate["2026-06-05"].pnl).toBeCloseTo(20, 6);
    expect(byDate["2026-06-05"].netFlow).toBe(0);
  });

  it("failure path — pct derived from rawDelta (deposit-day leak) throws pct-drift diagnostic", () => {
    // Trading day WITH a coincident deposit: rawDelta=+1010, netFlow=+1000,
    // trading pnl=+10. Correct pct = 10/1010 ≈ 0.99%. The leaky mock
    // instead reports pct from rawDelta (1010/1010 = 100%). The card
    // reconstructs rawDelta as pnl+netFlow before running its own guard,
    // so the arithmetic identity survives — the pct-derivation branch is
    // what catches the leak.
    mockedCompute.mockImplementation((): DailyEquityChange[] => [
      {
        date: "2026-06-03",
        prevDate: "2026-06-02",
        prevEquity: 1_010,
        equity: 2_020,
        rawDelta: 1_010,
        netFlow: 1_000,
        pnl: 10,
        pct: 100, // ← LEAK: derived from rawDelta, not pnl
        basisReset: false,
      },
    ]);

    expect(() => render()).toThrow(/DailyEquityChangesCard\.chartData.*pct drift on 2026-06-03/);
  });

  it("failure path — withdrawal-day leak (negative flow bled into pct) throws", () => {
    // Withdrawal day: rawDelta=-490, netFlow=-500, trading pnl=+10.
    // Correct pct = 10/2020 ≈ 0.495%. Leaky mock reports pct from
    // rawDelta (-490/2020 = -24.26%) — a big red bar where a small
    // green one should be.
    mockedCompute.mockImplementation((): DailyEquityChange[] => [
      {
        date: "2026-06-04",
        prevDate: "2026-06-03",
        prevEquity: 2_020,
        equity: 1_530,
        rawDelta: -490,
        netFlow: -500,
        pnl: 10,
        pct: (-490 / 2_020) * 100, // ← LEAK
        basisReset: false,
      },
    ]);

    expect(() => render()).toThrow(/DailyEquityChangesCard\.chartData.*pct drift on 2026-06-04/);
  });
});
