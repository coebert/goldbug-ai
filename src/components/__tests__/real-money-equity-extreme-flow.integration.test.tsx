// Integration test: real-money equity tile through the FULL dashboard
// data-flow with extreme snapshot magnitudes.
//
// Pipeline exercised (identical to production):
//   equity_snapshots rows  →  buildAllPortfoliosEquity
//                          →  computeModeSummary
//                          →  <ModeSummaryTile /> (SSR HTML)
//
// This complements the property test (which fuzzes the tile in
// isolation) by driving REAL snapshot rows through the store /
// aggregator layer and asserting the tile still renders safely for:
//   1. Near-zero magnitudes: sub-penny totals, exactly £0.00, and
//      swings that cross zero.
//   2. Very large magnitudes: mega-cap-sized totals (£1e9, £1e12),
//      and pathological upper-bound totals (Number.MAX_SAFE_INTEGER).
//
// Invariants asserted for every scenario:
//   - summary is non-null and every field is finite,
//   - rendered HTML contains no "NaN", "Infinity", "£NaN", "NaN%",
//     or scientific notation like "1e+21",
//   - the tone class matches the sign of pnl,
//   - the headline £ tile matches the aggregator's `now` when
//     formatted with the same Intl options the component uses.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAllPortfoliosEquity,
  type EquitySnapshotInput,
  type PortfolioEquityInput,
} from "@/lib/all-portfolios-equity";
import { computeModeSummary } from "@/lib/mode-summary";
import { ModeSummaryTile } from "@/routes/index";

const LIVE: PortfolioEquityInput = {
  id: "live-1",
  name: "Live Saxo",
  currency: "GBP",
  mode: "live_prod",
  starting_cash: 300,
  current_cash: 300,
};

const FORBIDDEN = /NaN|Infinity|£NaN|[0-9](?:\.[0-9]+)?[eE][+-]?[0-9]/;

function runPipeline(snapshots: EquitySnapshotInput[], today: string) {
  const data = buildAllPortfoliosEquity({ portfolios: [LIVE], snapshots, today });
  const summary = computeModeSummary(
    data.series as Array<{ date: string } & Record<string, number | string>>,
    data.portfolios,
    [],
  );
  if (!summary) throw new Error("expected non-null summary");
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
  return { s: summary.real, html };
}

function assertSafeRender(html: string, context: string) {
  expect(html, context).not.toMatch(FORBIDDEN);
  expect(html, context).toContain("Real-money equity");
}

function assertFiniteSummary(s: { now: number; pnl: number; pct: number }, ctx: string) {
  expect(Number.isFinite(s.now), `${ctx}: now`).toBe(true);
  expect(Number.isFinite(s.pnl), `${ctx}: pnl`).toBe(true);
  expect(Number.isFinite(s.pct), `${ctx}: pct`).toBe(true);
}

const GBP0 = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

describe("real-money equity tile — full dashboard flow with extreme snapshot values", () => {
  it("handles two consecutive £0.00 snapshots (crash-safe zero baseline)", () => {
    const { s, html } = runPipeline(
      [
        { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 0 },
        { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: 0 },
      ],
      "2026-07-23",
    );
    assertFiniteSummary(s, "zero-zero");
    expect(s.now).toBe(0);
    expect(s.pnl).toBe(0);
    expect(s.pct).toBe(0);
    assertSafeRender(html, "zero-zero");
    expect(html).toContain(GBP0.format(0));
    expect(html).toContain("0.00%");
  });

  it("handles sub-penny snapshots (0.001 → 0.002) without scientific-notation leakage", () => {
    const { s, html } = runPipeline(
      [
        { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 0.001 },
        { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: 0.002 },
      ],
      "2026-07-23",
    );
    assertFiniteSummary(s, "sub-penny");
    expect(s.now).toBeCloseTo(0.002, 10);
    expect(s.pnl).toBeCloseTo(0.001, 10);
    expect(s.pct).toBeCloseTo(100, 5); // doubled from 0.001 → 0.002
    assertSafeRender(html, "sub-penny");
    // Headline is rounded to whole £, so 0.002 → "£0". Percentage still gained.
    expect(html).toContain(GBP0.format(0));
    expect(html).toContain("text-emerald-400");
  });

  it("handles a snapshot swing that crosses zero (£100 → £0 → £-50 phantom)", () => {
    // Guard against divide-by-zero in the second window where previous = 0.
    const { s, html } = runPipeline(
      [
        { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 100 },
        { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: 0 },
        { portfolio_id: "live-1", snapshot_date: "2026-07-24", total_value: -50 },
      ],
      "2026-07-24",
    );
    assertFiniteSummary(s, "zero-crossing");
    expect(s.now).toBe(-50);
    expect(s.pnl).toBe(-50); // 0 → -50
    expect(s.pct).toBe(0);   // prev <= 0 → safe 0, not -Infinity
    assertSafeRender(html, "zero-crossing");
    expect(html).toContain("text-red-400");
  });

  it("handles a billion-pound snapshot without scientific notation", () => {
    const oneBn = 1_000_000_000;
    const { s, html } = runPipeline(
      [
        { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: oneBn },
        { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: oneBn * 1.1 },
      ],
      "2026-07-23",
    );
    assertFiniteSummary(s, "1e9");
    expect(s.now).toBe(oneBn * 1.1);
    expect(s.pnl).toBeCloseTo(oneBn * 0.1, 0);
    expect(s.pct).toBeCloseTo(10, 5);
    assertSafeRender(html, "1e9");
    // Grouping should include the thousands separators for a big £ value.
    expect(html).toContain(GBP0.format(oneBn * 1.1));
    expect(html).toContain("+10.00%");
  });

  it("handles a trillion-pound snapshot (£1e12) with a modest delta", () => {
    const oneTn = 1_000_000_000_000;
    const { s, html } = runPipeline(
      [
        { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: oneTn },
        { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: oneTn + 5 },
      ],
      "2026-07-23",
    );
    assertFiniteSummary(s, "1e12");
    expect(s.now).toBe(oneTn + 5);
    expect(s.pnl).toBe(5);
    assertSafeRender(html, "1e12");
    expect(html).toContain(GBP0.format(oneTn + 5));
  });

  it("handles Number.MAX_SAFE_INTEGER as an upper-bound snapshot", () => {
    // Pathological but should still round-trip cleanly through Intl.
    const big = Number.MAX_SAFE_INTEGER; // 2^53 − 1
    const { s, html } = runPipeline(
      [
        { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 1 },
        { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: big },
      ],
      "2026-07-23",
    );
    assertFiniteSummary(s, "MAX_SAFE_INTEGER");
    expect(s.now).toBe(big);
    assertSafeRender(html, "MAX_SAFE_INTEGER");
    expect(html).toContain(GBP0.format(big));
    // pct = (big - 1) / 1 * 100 is huge but must format as decimal, not exp.
    expect(html).not.toMatch(/[0-9]e\+/i);
  });

  it("survives a burst of alternating extreme snapshots without stale/renderer artefacts", () => {
    // Feed the pipeline 8 rows swinging between near-zero and £1e10.
    // Every intermediate render must be clean.
    const values = [0, 1e10, 0.5, 1e9, 1e-3, 5e10, 0, 1e10];
    const snapshots: EquitySnapshotInput[] = values.map((v, i) => ({
      portfolio_id: "live-1",
      snapshot_date: `2026-07-${String(15 + i).padStart(2, "0")}`,
      total_value: v,
    }));
    // Walk the timeline day by day, re-rendering the tile each step.
    for (let i = 0; i < snapshots.length; i++) {
      const slice = snapshots.slice(0, i + 1);
      const today = snapshots[i].snapshot_date;
      const { s, html } = runPipeline(slice, today);
      assertFiniteSummary(s, `burst day ${i}`);
      assertSafeRender(html, `burst day ${i}`);
      // Tone class MUST match pnl sign.
      const tone = s.pnl >= 0 ? "text-emerald-400" : "text-red-400";
      expect(html, `burst day ${i} tone`).toContain(tone);
    }
  });
});
