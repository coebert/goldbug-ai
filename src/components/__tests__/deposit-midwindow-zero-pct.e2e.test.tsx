// End-to-end: a mid-window cash deposit must NOT masquerade as trading
// profit on the dashboard. The real-money equity tile should render
// exactly "+0.00%" (with the emerald "gain" tone reserved for pnl ≥ 0
// but a zero pnl amount) until real trading gains or losses appear.
//
// Pipeline exercised (same order as the live dashboard):
//   stored snapshots + sim_fund_events  →  buildAllPortfoliosEquity
//   →  computeModeSummary                →  <ModeSummaryTile />
//
// Timeline:
//   Day 1  £300 baseline snapshot, no deposits, no trades
//   Day 2  User deposits £200 mid-window (snapshot rises to £500 from cash)
//          → tile must show £500 headline but 0% / £0 pnl
//   Day 3  Trading gains £25 on top of the £500 baseline (snapshot £525)
//          → tile finally shows +5.00% / +£25 (deposit still netted out)
//   Day 4  Trading pulls back £40 (snapshot £485)
//          → tile shows the loss in red, deposit stays netted out

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAllPortfoliosEquity,
  type EquitySnapshotInput,
  type PortfolioEquityInput,
} from "@/lib/all-portfolios-equity";
import {
  computeModeSummary,
  type DepositEvent,
} from "@/lib/mode-summary";
import { ModeSummaryTile } from "@/routes/index";

const LIVE: PortfolioEquityInput = {
  id: "live-1",
  name: "Live Saxo",
  currency: "GBP",
  mode: "live_prod",
  starting_cash: 300,
  current_cash: 300,
};

function runPipeline(
  snapshots: EquitySnapshotInput[],
  deposits: DepositEvent[],
  today: string,
) {
  const data = buildAllPortfoliosEquity({
    portfolios: [LIVE],
    snapshots,
    today,
  });
  const summary = computeModeSummary(
    data.series as Array<{ date: string } & Record<string, number | string>>,
    data.portfolios,
    deposits,
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
  return { summary: summary.real, html };
}

function numericTokens(html: string): number[] {
  return (html.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((t) => Number(t.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

describe("dashboard e2e — mid-window deposit shows 0% until trading moves", () => {
  it("deposit-only day renders £0 pnl and +0.00%, later trading days move the tile", () => {
    // --- Day 1: baseline £300, no deposits. --------------------------
    let snapshots: EquitySnapshotInput[] = [
      { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 300 },
    ];
    let deposits: DepositEvent[] = [];
    let step = runPipeline(snapshots, deposits, "2026-07-22");
    // Single snapshot → no delta window yet.
    expect(step.summary.now).toBe(300);
    expect(step.summary.pnl).toBe(0);
    expect(step.summary.pct).toBe(0);

    // --- Day 2: user deposits £200. Snapshot reflects the cash bump. --
    // Without deposit-netting this would look like a +66.67% gain.
    snapshots = [
      ...snapshots,
      { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: 500 },
    ];
    deposits = [
      { portfolio_id: "live-1", date: "2026-07-23", amount: 200 },
    ];
    step = runPipeline(snapshots, deposits, "2026-07-23");
    expect(step.summary.now).toBe(500);
    // pnl = (500 − 300) − 200 = 0. pct = 0.
    expect(step.summary.pnl).toBe(0);
    expect(step.summary.pct).toBe(0);
    // Rendered tile shows the new headline £500 but zero movement — the
    // "+" sign is emitted because pnl ≥ 0, but the number itself is 0.
    const nums2 = numericTokens(step.html);
    expect(nums2).toContain(500);
    expect(step.html).toContain("+0.00%");
    expect(step.html).toContain("+0");
    // Regression guard: the deposit must NOT surface as a +66.67% gain
    // (that's the raw un-netted delta) or any other non-zero %.
    expect(step.html).not.toContain("66.67");
    expect(step.html).not.toMatch(/[+-](?!0\.00)\d+\.\d{2}%/);


    // --- Day 3: real trading gain of £25 on top of the £500 base. -----
    snapshots = [
      ...snapshots,
      { portfolio_id: "live-1", snapshot_date: "2026-07-24", total_value: 525 },
    ];
    // No new deposit today.
    step = runPipeline(snapshots, deposits, "2026-07-24");
    // Previous snapshot equity is £500 (post-deposit); no in-window
    // deposit → pnl = 25, pct = 5%.
    expect(step.summary.now).toBe(525);
    expect(step.summary.pnl).toBe(25);
    expect(step.summary.pct).toBeCloseTo(5, 5);
    expect(step.html).toContain("+5.00%");
    expect(step.html).toContain("text-emerald-400");

    // --- Day 4: pullback of £40 (525 → 485). --------------------------
    snapshots = [
      ...snapshots,
      { portfolio_id: "live-1", snapshot_date: "2026-07-25", total_value: 485 },
    ];
    step = runPipeline(snapshots, deposits, "2026-07-25");
    expect(step.summary.now).toBe(485);
    expect(step.summary.pnl).toBe(-40);
    expect(step.summary.pct).toBeCloseTo((-40 / 525) * 100, 5);
    expect(step.html).toContain("-7.62%");
    expect(step.html).toContain("text-red-400");
    expect(step.html).not.toContain("+-"); // no double sign
  });

  it("same-day deposit + snapshot arrival still nets to 0% (no phantom gain)", () => {
    // Baseline first, then a single day where equity jumps entirely
    // because of the deposit (no trades). Tile must be flat.
    const snapshots: EquitySnapshotInput[] = [
      { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 300 },
      { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: 800 },
    ];
    const deposits: DepositEvent[] = [
      // Split into two same-day events to prove the summation path works.
      { portfolio_id: "live-1", date: "2026-07-23", amount: 300 },
      { portfolio_id: "live-1", date: "2026-07-23", amount: 200 },
    ];
    const step = runPipeline(snapshots, deposits, "2026-07-23");
    expect(step.summary.now).toBe(800);
    expect(step.summary.pnl).toBe(0);
    expect(step.summary.pct).toBe(0);
    expect(step.html).toContain("+0.00%");
    expect(numericTokens(step.html)).toContain(800);
  });
});
