// End-to-end regression: multiple snapshot-arrival events for the SAME
// day fire concurrently (broker retries, webhook replays, parallel
// reconciliation jobs). The real-money equity tile must remain
// idempotent and consistent:
//
//   1. N identical same-day arrivals collapse to a single logical row —
//      the rendered HTML is byte-identical to a single arrival.
//   2. Interleaved arrival ORDER never changes the output when the
//      payload is the same.
//   3. Re-running the pipeline over the accumulated snapshots is
//      idempotent (pure function of its input set).
//   4. When same-day arrivals disagree on the total_value (intraday
//      broker replays with drift), the pipeline is deterministic w.r.t.
//      the accumulated array: two runs over the identical accumulated
//      array produce identical HTML, and the rendered value is one of
//      the arrived values (never a phantom sum / average / regression
//      to an earlier date).
//
// Pipeline exercised (same as the live dashboard):
//   concurrent stored-snapshot arrivals
//     → shared accumulator (append on arrival)
//     → buildAllPortfoliosEquity
//     → computeModeSummary
//     → <ModeSummaryTile />

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

/**
 * Simulate `count` concurrent arrivals of `row`. Each arrival waits a
 * jittered microtask, then appends to a shared array — mirroring the
 * real dashboard where multiple fetches/subscriptions land into the
 * same in-memory snapshot cache under an unpredictable interleaving.
 */
async function concurrentArrivals(
  base: EquitySnapshotInput[],
  row: EquitySnapshotInput,
  count: number,
  seed = 1,
): Promise<EquitySnapshotInput[]> {
  const accumulator: EquitySnapshotInput[] = [...base];
  // Deterministic LCG for reproducible jitter.
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
  await Promise.all(
    Array.from({ length: count }, () =>
      new Promise<void>((resolve) => {
        const delay = Math.floor(rand() * 4);
        setTimeout(() => {
          accumulator.push(row);
          resolve();
        }, delay);
      }),
    ),
  );
  return accumulator;
}

const CHRON: EquitySnapshotInput[] = [
  { portfolio_id: "live-1", snapshot_date: "2026-07-20", total_value: 300 },
  { portfolio_id: "live-1", snapshot_date: "2026-07-21", total_value: 315 },
  { portfolio_id: "live-1", snapshot_date: "2026-07-22", total_value: 330 },
];
const TODAY_ROW: EquitySnapshotInput = {
  portfolio_id: "live-1",
  snapshot_date: "2026-07-23",
  total_value: 360,
};
const TODAY = "2026-07-23";

describe("real-money equity tile — concurrent same-day arrival e2e", () => {
  it("N identical concurrent arrivals collapse to the single-arrival output", async () => {
    const single = runPipeline([...CHRON, TODAY_ROW], TODAY);

    // 8 concurrent arrivals of the SAME today row.
    const accumulated = await concurrentArrivals(CHRON, TODAY_ROW, 8, 42);
    // Sanity: the accumulator really did receive 8 copies of the row.
    const todayCopies = accumulated.filter(
      (s) => s.snapshot_date === TODAY_ROW.snapshot_date,
    );
    expect(todayCopies).toHaveLength(8);

    const afterConcurrent = runPipeline(accumulated, TODAY);
    expect(afterConcurrent.summary).toEqual(single.summary);
    expect(afterConcurrent.html).toBe(single.html);

    // And the headline still reads £360 — no phantom multiplied value
    // like 8 × 360 = 2880 leaking into the tile.
    expect(afterConcurrent.summary.now).toBe(360);
    expect(numericTokens(afterConcurrent.html)).toContain(360);
    expect(numericTokens(afterConcurrent.html)).not.toContain(2880);
  });

  it("interleaved arrival orders yield byte-identical HTML for identical payloads", async () => {
    // Two independent concurrent runs with different jitter seeds — the
    // arrival order into each accumulator is different, but the rendered
    // tile MUST be byte-identical because the payload set is identical.
    const runA = await concurrentArrivals(CHRON, TODAY_ROW, 6, 7);
    const runB = await concurrentArrivals(CHRON, TODAY_ROW, 6, 9999);

    const renderedA = runPipeline(runA, TODAY);
    const renderedB = runPipeline(runB, TODAY);
    expect(renderedB.summary).toEqual(renderedA.summary);
    expect(renderedB.html).toBe(renderedA.html);
  });

  it("pipeline is idempotent — re-running over the same accumulator matches", async () => {
    const accumulated = await concurrentArrivals(CHRON, TODAY_ROW, 5, 123);
    const first = runPipeline(accumulated, TODAY);
    const second = runPipeline(accumulated, TODAY);
    const third = runPipeline([...accumulated], TODAY); // fresh copy
    expect(second.html).toBe(first.html);
    expect(third.html).toBe(first.html);
  });

  it("concurrent arrivals never regress the tile to an earlier date's value", async () => {
    // Same-day retries land after the day-before snapshot is already in
    // the accumulator. The tile MUST show today's value (£360), never
    // yesterday's (£330) — no matter how the retries interleave.
    const accumulated = await concurrentArrivals(CHRON, TODAY_ROW, 4, 31337);
    const rendered = runPipeline(accumulated, TODAY);
    expect(rendered.summary.now).toBe(360);
    expect(rendered.summary.pnl).toBe(30); // 360 − 330
    expect(rendered.summary.pct).toBeCloseTo((30 / 330) * 100, 5);
    expect(numericTokens(rendered.html)).toContain(360);
    expect(numericTokens(rendered.html)).not.toContain(330);
    expect(rendered.html).toContain("text-emerald-400");
  });

  it("same-day arrivals with intraday drift resolve deterministically per accumulator", async () => {
    // Broker replays the same day with slightly different intraday
    // values (357, 359, 360, 361, 358). The pipeline is a pure function
    // of the accumulated array: given the SAME accumulator, two runs
    // must produce byte-identical HTML, and the rendered value must be
    // ONE of the arrived intraday values (never an average, sum, or a
    // regression to yesterday's £330).
    const intraday: EquitySnapshotInput[] = [357, 359, 360, 361, 358].map(
      (v) => ({
        portfolio_id: "live-1",
        snapshot_date: TODAY,
        total_value: v,
      }),
    );

    // Concurrent-ish accumulation with jitter.
    const accumulator: EquitySnapshotInput[] = [...CHRON];
    await Promise.all(
      intraday.map(
        (row, i) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              accumulator.push(row);
              resolve();
            }, (i * 7) % 5);
          }),
      ),
    );

    const runOnce = runPipeline(accumulator, TODAY);
    const runTwice = runPipeline(accumulator, TODAY);

    // Idempotent for the same accumulator.
    expect(runTwice.html).toBe(runOnce.html);
    expect(runTwice.summary).toEqual(runOnce.summary);

    // The rendered "now" must be one of the arrived intraday values —
    // never a phantom sum (1795), average (359), or yesterday (330).
    const arrivedValues = intraday.map((r) => Number(r.total_value));
    expect(arrivedValues).toContain(runOnce.summary.now);
    expect(runOnce.summary.now).not.toBe(330);
    expect(runOnce.summary.now).not.toBe(1795);
    expect(runOnce.summary.now).not.toBe(359);

    // Previous-window anchor is unchanged (still yesterday's £330), so
    // pct is (now − 330) / 330 regardless of which intraday won.
    const expectedPnl = runOnce.summary.now - 330;
    expect(runOnce.summary.pnl).toBe(expectedPnl);
    expect(runOnce.summary.pct).toBeCloseTo((expectedPnl / 330) * 100, 5);
  });
});
