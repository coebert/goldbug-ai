// End-to-end regression: the real-money equity tile must react when a
// fresh market snapshot lands in `equity_snapshots`.
//
// Pipeline exercised (same order as the live dashboard):
//   stored snapshots  →  buildAllPortfoliosEquity  →  computeModeSummary
//   →  <ModeSummaryTile />
//
// We simulate three sequential arrivals of `equity_snapshots` rows for
// a single live-money portfolio and assert both:
//   (a) the numeric tile inputs (`now`, `pnl`, `pct`) update from one
//       arrival to the next, and
//   (b) the rendered HTML shows the new value + signed delta + tone
//       class matching the direction of the change.
//
// This locks down the "snapshot arrives → tile updates" contract so a
// future selector/reducer/render regression trips this test rather
// than shipping to production silently.

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

/** Full pipeline: stored rows → summary → rendered real-money tile. */
function runPipeline(snapshots: EquitySnapshotInput[], today: string) {
  const data = buildAllPortfoliosEquity({
    portfolios: [LIVE],
    snapshots,
    today,
  });
  const summary = computeModeSummary(data.series as Array<{ date: string } & Record<string, number | string>>, data.portfolios, []);
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
  return { summary: summary.real, html };
}

function numericTokens(html: string): number[] {
  return (html.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((t) => Number(t.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

describe("real-money equity tile — snapshot arrival e2e", () => {
  it("updates value, PnL, and tone as successive snapshots arrive", () => {
    // --- Arrival 1: baseline only (£300, single snapshot). ------------
    let snapshots: EquitySnapshotInput[] = [
      { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 300 },
    ];
    let step = runPipeline(snapshots, "2026-07-22");
    expect(step.summary.now).toBe(300);
    expect(step.summary.pnl).toBe(0);
    expect(step.summary.pct).toBe(0);
    expect(step.html).toContain("Real-money equity");
    expect(numericTokens(step.html)).toContain(300);

    // --- Arrival 2: new market snapshot at £330 (gain). ---------------
    snapshots = [
      ...snapshots,
      { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: 330 },
    ];
    step = runPipeline(snapshots, "2026-07-23");
    expect(step.summary.now).toBe(330);
    expect(step.summary.pnl).toBe(30);
    expect(step.summary.pct).toBeCloseTo(10, 5);
    // Rendered tile MUST show the new value and a positive-tone class.
    const nums2 = numericTokens(step.html);
    expect(nums2).toContain(330);
    expect(nums2).not.toContain(300); // headline value is 330, not stale 300
    expect(step.html).toContain("+10.00%");
    expect(step.html).toContain("text-emerald-400");

    // --- Arrival 3: pullback snapshot at £315 (loss vs previous). -----
    snapshots = [
      ...snapshots,
      { portfolio_id: "live-1", snapshot_date: "2026-07-24", total_value: 315 },
    ];
    step = runPipeline(snapshots, "2026-07-24");
    expect(step.summary.now).toBe(315);
    expect(step.summary.pnl).toBe(-15);
    expect(step.summary.pct).toBeCloseTo(-15 / 330 * 100, 5); // ≈ -4.545%
    const nums3 = numericTokens(step.html);
    expect(nums3).toContain(315);
    // Sign prefix rendered without a spurious "+" and destructive tone applied.
    expect(step.html).toContain("-4.55%");
    expect(step.html).not.toContain("+-");
    expect(step.html).toContain("text-rose-400");
  });

  it("a same-day repeated snapshot (idempotent) does not fabricate a delta", () => {
    // Two rows for the same date — buildAllPortfoliosEquity dedupes by
    // (portfolio, date). The tile must stay at the baseline with 0 pnl,
    // not invent a phantom gain/loss from the duplicated arrival.
    const snapshots: EquitySnapshotInput[] = [
      { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 300 },
      { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 300 },
    ];
    const step = runPipeline(snapshots, "2026-07-22");
    expect(step.summary.now).toBe(300);
    expect(step.summary.pnl).toBe(0);
    expect(step.summary.pct).toBe(0);
    expect(numericTokens(step.html)).toContain(300);
  });
});
