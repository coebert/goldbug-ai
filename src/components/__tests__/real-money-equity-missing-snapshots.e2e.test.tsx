// Verify the real-money equity tile renders SAFE PLACEHOLDERS — never
// "£NaN", never a bogus historical figure — when the latest stored
// snapshot is missing or has null cash/holdings totals.
//
// Runs the same pipeline as the dashboard:
//   stored rows → buildAllPortfoliosEquity → todaySummary reducer →
//   <ModeSummaryTile />
//
// The safe-placeholder contract:
//   • no real portfolio at all           → "No real-money portfolios"
//   • real portfolio exists, no valid    → count=1, headline = £0, delta = +0.00%
//     snapshot on/before today             (never NaN, never a stale value)
//   • latest snapshot has null totals    → treated as missing; same as above
//   • all past snapshots null            → same as above (no phantom carry)

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAllPortfoliosEquity,
  type PortfolioEquityInput,
  type EquitySnapshotInput,
} from "@/lib/all-portfolios-equity";
import { ModeSummaryTile } from "@/routes/index";

const LIVE = "11111111-1111-4111-8111-111111111111";
const SIM = "22222222-2222-4222-8222-222222222222";
const TODAY = "2026-07-24";

function computeTodaySummary(
  data: ReturnType<typeof buildAllPortfoliosEquity>,
) {
  const { series, portfolios } = data;
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

function renderReal(
  real: { now: number; pnl: number; pct: number; count: number },
) {
  return renderToStaticMarkup(
    <ModeSummaryTile
      label="Real-money equity"
      sublabel="REAL · live Saxo"
      tone="real"
      money={real.now}
      pnl={real.pnl}
      pct={real.pct}
      count={real.count}
    />,
  );
}

function build(
  portfolios: PortfolioEquityInput[],
  snapshots: EquitySnapshotInput[],
) {
  const data = buildAllPortfoliosEquity({ portfolios, snapshots, today: TODAY });
  return renderReal(computeTodaySummary(data).real);
}

function assertSafe(html: string) {
  // The tile must never surface NaN/undefined/null anywhere in the DOM.
  expect(html).not.toMatch(/NaN/);
  expect(html).not.toMatch(/undefined/);
  expect(html).not.toMatch(/>null</);
  // Never a "£" glued to a non-digit — catches "£NaN", "£-", "£ ".
  expect(html).not.toMatch(/£[^\d\-−(]/);
}

describe("real-money equity tile — safe placeholders for missing/null snapshots", () => {
  it("no real-money portfolio at all → empty-state placeholder, no NaN", () => {
    const html = build(
      [
        {
          id: SIM,
          name: "Sim A",
          currency: "GBP",
          mode: "paper",
          starting_cash: 1000,
          current_cash: 1040,
        },
      ],
      [{ portfolio_id: SIM, snapshot_date: TODAY, total_value: 1040 }],
    );
    expect(html).toContain("No real-money portfolios");
    assertSafe(html);
  });

  it("real portfolio exists but zero snapshots → falls back to current_cash on today, never NaN", () => {
    const html = build(
      [
        {
          id: LIVE,
          name: "Live Saxo",
          currency: "GBP",
          mode: "live_prod",
          starting_cash: 300,
          current_cash: 300,
        },
      ],
      [],
    );
    // Safe placeholder: shows £300 (current_cash) not NaN, count=1.
    expect(html).toContain("£300");
    expect(html).toContain("1 portfolio");
    expect(html).toContain("+0.00%");
    assertSafe(html);
  });

  it("real portfolio with null current_cash AND no snapshots → renders £0 placeholder", () => {
    const html = build(
      [
        {
          id: LIVE,
          name: "Live Saxo",
          currency: "GBP",
          mode: "live_prod",
          starting_cash: null,
          current_cash: null,
        },
      ],
      [],
    );
    expect(html).toContain("£0");
    expect(html).toContain("+0.00%");
    expect(html).toContain("1 portfolio");
    assertSafe(html);
  });

  it("latest snapshot has null total_value → coerced to 0, safe (£0) not NaN", () => {
    const html = build(
      [
        {
          id: LIVE,
          name: "Live Saxo",
          currency: "GBP",
          mode: "live_prod",
          starting_cash: 300,
          current_cash: 300,
        },
      ],
      [{ portfolio_id: LIVE, snapshot_date: TODAY, total_value: null }],
    );
    // Number(null) === 0, so the null snapshot lands as £0. The critical
    // guarantee is: no NaN, no bogus historical value, count still shown.
    expect(html).toContain("£0");
    expect(html).toContain("1 portfolio");
    assertSafe(html);
  });

  it("ALL snapshots null → tile stays at safe £0 placeholder (no NaN, no phantom)", () => {
    const html = build(
      [
        {
          id: LIVE,
          name: "Live Saxo",
          currency: "GBP",
          mode: "live_prod",
          starting_cash: 300,
          current_cash: 300,
        },
      ],
      [
        { portfolio_id: LIVE, snapshot_date: "2026-07-22", total_value: null },
        { portfolio_id: LIVE, snapshot_date: "2026-07-23", total_value: null },
        { portfolio_id: LIVE, snapshot_date: TODAY, total_value: null },
      ],
    );
    expect(html).toContain("£0");
    expect(html).toContain("1 portfolio");
    assertSafe(html);
  });


  it("non-numeric snapshot totals (string garbage) are filtered, no NaN leaks", () => {
    const html = build(
      [
        {
          id: LIVE,
          name: "Live Saxo",
          currency: "GBP",
          mode: "live_prod",
          starting_cash: 300,
          current_cash: 300,
        },
      ],
      [
        // Cast through unknown — the schema allows number|string|null; this
        // simulates a corrupted row from the DB.
        {
          portfolio_id: LIVE,
          snapshot_date: TODAY,
          total_value: "not-a-number" as unknown as string,
        },
      ],
    );
    expect(html).toContain("£300");
    assertSafe(html);
  });

  it("directly rendering the tile with NaN/null inputs still never emits NaN or null", () => {
    // Defensive: even if a caller ever passes NaN through, the tile's
    // Intl formatter is the last line of defence — this test locks in
    // that we surface a formatted number, not the literal 'NaN'.
    const html = renderToStaticMarkup(
      <ModeSummaryTile
        label="Real-money equity"
        sublabel="REAL · live Saxo"
        tone="real"
        money={Number.NaN}
        pnl={Number.NaN}
        pct={Number.NaN}
        count={1}
      />,
    );
    // If this fails, ModeSummaryTile needs a Number.isFinite guard before
    // handing values to Intl.NumberFormat.
    expect(html).not.toMatch(/NaN/);
  });

  it("empty-state placeholder never renders a currency figure", () => {
    const html = renderReal({ now: 0, pnl: 0, pct: 0, count: 0 });
    expect(html).toContain("No real-money portfolios");
    expect(html).not.toContain("£0");
    expect(html).not.toContain("+0.00%");
    assertSafe(html);
  });
});
