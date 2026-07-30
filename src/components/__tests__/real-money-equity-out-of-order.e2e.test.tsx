// End-to-end regression: the real-money equity tile must be immune to
// the ORDER in which stored `equity_snapshots` rows arrive from the
// backend. Snapshots can arrive out-of-order (backfills, retries,
// broker replays), and the dashboard must always reflect the row with
// the latest snapshot_date — never regress to an older value just
// because it was fetched most recently.
//
// Pipeline exercised (same order as the live dashboard):
//   stored snapshots (arbitrary order)
//     → buildAllPortfoliosEquity  (sorts by date, dedupes)
//     → computeModeSummary        (prev vs last window)
//     → <ModeSummaryTile />       (headline value + tone)
//
// The suite pins three invariants:
//   1. Shuffled arrival order yields the same summary + rendered HTML
//      as chronological arrival.
//   2. A late-arriving OLDER snapshot never overwrites the tile's
//      headline value — the newest snapshot_date always wins.
//   3. A late-arriving DUPLICATE of the current latest date is
//      idempotent — no phantom PnL, no tone flip.

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

function runPipeline(snapshots: EquitySnapshotInput[], today: string) {
  const data = buildAllPortfoliosEquity({
    portfolios: [LIVE],
    snapshots,
    today,
  });
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
  return { summary: summary.real, html };
}

function numericTokens(html: string): number[] {
  return (html.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((t) => Number(t.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

// Canonical chronological history the pipeline should always resolve
// to, regardless of the order rows arrive in.
const CHRON: EquitySnapshotInput[] = [
  { portfolio_id: "live-1", snapshot_date: "2026-07-20", total_value: 300 },
  { portfolio_id: "live-1", snapshot_date: "2026-07-21", total_value: 315 },
  { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 330 },
  { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: 360 },
];
const TODAY = "2026-07-23";

describe("real-money equity tile — out-of-order snapshot e2e", () => {
  it("shuffled arrival order produces the same summary + HTML as chronological", () => {
    const chronological = runPipeline(CHRON, TODAY);

    // Reverse order — worst case: newest row seen first.
    const reversed = runPipeline([...CHRON].reverse(), TODAY);
    expect(reversed.summary).toEqual(chronological.summary);
    expect(reversed.html).toBe(chronological.html);

    // Arbitrary shuffle (deterministic index permutation).
    const shuffled = [CHRON[2], CHRON[0], CHRON[3], CHRON[1]];
    const shuffledRun = runPipeline(shuffled, TODAY);
    expect(shuffledRun.summary).toEqual(chronological.summary);
    expect(shuffledRun.html).toBe(chronological.html);

    // Sanity: the tile shows £360 (the latest date's value) and a
    // positive tone, not any stale value from earlier in the history.
    expect(chronological.summary.now).toBe(360);
    expect(chronological.summary.pnl).toBe(30); // 360 - 330
    expect(numericTokens(chronological.html)).toContain(360);
    expect(chronological.html).toContain("text-success");
  });

  it("a late-arriving OLDER snapshot never regresses the headline value", () => {
    // Step 1: dashboard is at £360 (latest is 2026-07-23).
    const before = runPipeline(CHRON, TODAY);
    expect(before.summary.now).toBe(360);
    expect(numericTokens(before.html)).toContain(360);

    // Step 2: a stale backfill row for an OLDER date arrives late.
    // The tile MUST still show £360; it must not regress to £250.
    const withStaleBackfill: EquitySnapshotInput[] = [
      ...CHRON,
      {
        portfolio_id: "live-1",
        snapshot_date: "2026-07-19",
        total_value: 250,
      },
    ];
    const after = runPipeline(withStaleBackfill, TODAY);
    expect(after.summary.now).toBe(360);
    expect(numericTokens(after.html)).toContain(360);
    expect(numericTokens(after.html)).not.toContain(250);
    // Tone stays positive (previous is still 330 → +30 gain).
    expect(after.html).toContain("text-success");
  });

  it("a late-arriving OLDER row also does not distort the trailing delta", () => {
    // The previous-snapshot for the window is the row dated the day
    // before the latest — a backfill deep in the past must not become
    // the "previous" and inflate PnL to (360 − 250) = 110.
    const withStaleBackfill: EquitySnapshotInput[] = [
      ...CHRON,
      {
        portfolio_id: "live-1",
        snapshot_date: "2026-07-15",
        total_value: 250,
      },
    ];
    const step = runPipeline(withStaleBackfill, TODAY);
    expect(step.summary.pnl).toBe(30); // still 360 − 330, not 360 − 250
    expect(step.summary.pct).toBeCloseTo((30 / 330) * 100, 5);
    expect(step.html).not.toContain("+36.67%"); // what the bug would render
  });

  it("a late-arriving DUPLICATE of the current latest date is idempotent", () => {
    const baseline = runPipeline(CHRON, TODAY);

    // Second copy of the newest row arrives (retry, replay, etc.).
    // buildAllPortfoliosEquity dedupes by (portfolio, date), so the
    // rendered HTML MUST be byte-identical to the pre-duplicate run.
    const dup: EquitySnapshotInput[] = [
      ...CHRON,
      { portfolio_id: "live-1", snapshot_date: "2026-07-23", total_value: 360 },
    ];
    const afterDup = runPipeline(dup, TODAY);
    expect(afterDup.summary).toEqual(baseline.summary);
    expect(afterDup.html).toBe(baseline.html);
  });
});
