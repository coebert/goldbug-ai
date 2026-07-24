// Contract: computeModeSummary's trailing pct window is anchored to the
// LAST TWO rows that contain a value for the mode. The exact boundary
// rules are:
//   • prev anchor date  = the second-to-last mode-valued row's date
//   • last anchor date  = the last mode-valued row's date
//   • deposit is netted iff  prevDate  <  d.date  ≤  lastDate
//       (strict > prev, inclusive ≤ last)
//   • single mode-valued row → prev == last, pnl == 0, deposits ignored
//   • previous ≤ 0          → pct == 0 (denominator guard)
//
// These tests hammer trades and cash-flows that land *exactly* on the
// window cutoffs — the most common regression surface when someone
// tweaks the filter or the date comparison operators.

import { describe, expect, it } from "vitest";
import {
  computeModeSummary,
  type DepositEvent,
  type SummaryPortfolio,
  type SummarySeriesRow,
} from "@/lib/mode-summary";

const LIVE: SummaryPortfolio = { id: "live-1", mode: "live_prod" };
const LIVE_B: SummaryPortfolio = { id: "live-2", mode: "live_prod" };
const SIM: SummaryPortfolio = { id: "sim-1", mode: "paper" };

describe("computeModeSummary — window boundary contract", () => {
  it("single mode-valued row: pnl 0, pct 0, deposits at that date IGNORED", () => {
    // Only one snapshot exists for the real mode. Prev == last, so the
    // deposit-netting window is empty and pnl/pct MUST be 0 regardless
    // of any deposit on that date.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-21", "live-1": 1000 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 500 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.now).toBe(1000);
    expect(s?.real.pnl).toBe(0);
    expect(s?.real.pct).toBe(0);
  });

  it("deposit dated EXACTLY on the previous anchor is EXCLUDED (already baked into `previous`)", () => {
    // prev anchor = 2026-07-20, last = 2026-07-21. A deposit dated on
    // the prev anchor is already reflected in `previous` — netting it
    // would double-count. Boundary rule: d.date > prevDate (strict).
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 1200 }, // post-deposit already
      { date: "2026-07-21", "live-1": 1230 }, // pure £30 trading gain
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-20", amount: 200 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(30);
    expect(s?.real.pct).toBeCloseTo((30 / 1200) * 100, 10);
  });

  it("deposit dated EXACTLY on the last anchor is INCLUDED (netted out of pnl)", () => {
    // prev anchor = 2026-07-20, last = 2026-07-21. A £100 deposit
    // dated on the last anchor MUST be netted. Boundary rule:
    // d.date <= lastDate (inclusive).
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 1000 },
      { date: "2026-07-21", "live-1": 1150 }, // £50 trading + £100 deposit
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 100 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(50);
    expect(s?.real.pct).toBeCloseTo(5, 10);
  });

  it("deposit dated STRICTLY between prev and last is INCLUDED", () => {
    // The generic in-window case, guarded here as the interior
    // sibling of the two boundary tests above.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-18", "live-1": 1000 },
      { date: "2026-07-22", "live-1": 1075 }, // £75 trading + £-... wait
    ];
    // Trading gain = 50, deposit = 25 → equity delta 75.
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-20", amount: 25 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(50);
    expect(s?.real.pct).toBeCloseTo(5, 10);
  });

  it("first-snapshot-only trade: single row means no trading pnl is inferred", () => {
    // The very first day the mode ever appears in the series has no
    // prior anchor. Even a big trade "at the cutoff" of day one shows
    // pnl 0 — you need two mode-valued rows to define a delta.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-01", "live-1": 500 }, // opening day trade result
    ];
    const s = computeModeSummary(series, [LIVE]);
    expect(s?.real.now).toBe(500);
    expect(s?.real.pnl).toBe(0);
    expect(s?.real.pct).toBe(0);
  });

  it("last-snapshot cutoff: a fresh row arriving today defines the new `last`", () => {
    // Adding a third snapshot slides the window forward: the OLD last
    // becomes the new prev anchor, and yesterday's deposit that was
    // in-window is now OUT of window (it's on the new prev anchor).
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 100 },
    ];

    // Before today's snapshot: window is 07-20 → 07-21, deposit
    // dated 07-21 is on the last anchor → INCLUDED.
    const two: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 1000 },
      { date: "2026-07-21", "live-1": 1150 },
    ];
    const before = computeModeSummary(two, [LIVE], events);
    expect(before?.real.pnl).toBe(50);

    // After today's snapshot arrives: window slides to 07-21 → 07-22.
    // The 07-21 deposit is now ON the prev anchor → EXCLUDED. Trading
    // pnl over the new window is purely 1180 − 1150 = 30.
    const three: SummarySeriesRow[] = [
      ...two,
      { date: "2026-07-22", "live-1": 1180 },
    ];
    const after = computeModeSummary(three, [LIVE], events);
    expect(after?.real.pnl).toBe(30);
    expect(after?.real.pct).toBeCloseTo((30 / 1150) * 100, 10);
  });

  it("per-mode window anchors independently: sim's last row can differ from real's last row", () => {
    // Sim has a snapshot today; real's most recent is yesterday. The
    // mode window must anchor per mode — sim's `last` = today, real's
    // `last` = yesterday — and each pnl/pct honours its own boundary.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-19", "live-1": 1000, "sim-1": 500 },
      { date: "2026-07-20", "live-1": 1030 },                 // real-only row
      { date: "2026-07-21", "sim-1": 540 },                   // sim-only row
    ];
    const s = computeModeSummary(series, [SIM, LIVE]);
    // Real window = 07-19 → 07-20: pnl 30, pct 3%.
    expect(s?.real.now).toBe(1030);
    expect(s?.real.pnl).toBe(30);
    expect(s?.real.pct).toBeCloseTo(3, 10);
    // Sim window = 07-19 → 07-21: pnl 40, pct 8%.
    expect(s?.sim.now).toBe(540);
    expect(s?.sim.pnl).toBe(40);
    expect(s?.sim.pct).toBeCloseTo(8, 10);
  });

  it("per-mode window: a deposit on real's `last` is IN for real but OUT for sim if sim's window is elsewhere", () => {
    // Real window ends 07-20; sim window ends 07-21. A deposit dated
    // 07-20 targeting a real portfolio is on real's `last` anchor →
    // included for real. It has no bearing on sim.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-19", "live-1": 1000, "sim-1": 500 },
      { date: "2026-07-20", "live-1": 1080 },
      { date: "2026-07-21", "sim-1": 520 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-20", amount: 50 },
    ];
    const s = computeModeSummary(series, [SIM, LIVE], events);
    // Real: 1080 − 1000 = 80 gross; net deposit 50 → trading pnl 30.
    expect(s?.real.pnl).toBe(30);
    expect(s?.real.pct).toBeCloseTo(3, 10);
    // Sim: no cash-flow → pure £20 trading gain.
    expect(s?.sim.pnl).toBe(20);
    expect(s?.sim.pct).toBeCloseTo(4, 10);
  });

  it("previous == 0: pct is guarded to 0 even when pnl > 0 (starting-from-empty boundary)", () => {
    // The mode starts at 0 on day one and grows to 100 via a deposit.
    // pnl is netted to 0 correctly; pct MUST also be 0 (guard against
    // divide-by-zero at the opening boundary).
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 0 },
      { date: "2026-07-21", "live-1": 100 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 100 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(0);
    expect(s?.real.pct).toBe(0);
  });

  it("previous == 0 with a real trading gain: pct still guarded to 0 (no divide-by-zero)", () => {
    // Even if trading pnl is truly positive, previous ≤ 0 forces the
    // denominator guard. The tile shows pnl but pct 0 — locking the
    // documented behaviour.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 0 },
      { date: "2026-07-21", "live-1": 25 },
    ];
    const s = computeModeSummary(series, [LIVE]);
    expect(s?.real.pnl).toBe(25);
    expect(s?.real.pct).toBe(0);
  });

  it("previous < 0: pct is guarded to 0 (short-balance edge)", () => {
    // Underlying data could theoretically be negative (e.g. margin
    // debit not otherwise supported, or a corrupted snapshot). The
    // denominator guard requires `previous > 0`; anything else → 0.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": -50 },
      { date: "2026-07-21", "live-1": 100 },
    ];
    const s = computeModeSummary(series, [LIVE]);
    expect(s?.real.pnl).toBe(150);
    expect(s?.real.pct).toBe(0);
  });

  it("multi-portfolio mode: `last` is the latest row where ANY portfolio in the mode has a value", () => {
    // Two live portfolios. live-2 has a snapshot on a later date than
    // live-1. The mode `last` picks up that later row; `now` sums both
    // portfolios' latest-known values via the merged series.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 600, "live-2": 400 }, // both present
      { date: "2026-07-21", "live-1": 620, "live-2": 400 }, // live-2 unchanged, still in row
      { date: "2026-07-22", "live-2": 430 },                // live-1 missing today
    ];
    // Real window = 07-21 → 07-22 (last two rows with any real value).
    // prev  sums live-1(620) + live-2(400) = 1020
    // last  sums live-1(NaN→skip) + live-2(430) = 430
    const s = computeModeSummary(series, [LIVE, LIVE_B]);
    expect(s?.real.now).toBe(430);
    expect(s?.real.pnl).toBe(430 - 1020);
    expect(s?.real.pct).toBeCloseTo(((430 - 1020) / 1020) * 100, 10);
  });

  it("deposit dated one day BEFORE prev anchor is out; ONE day INTO the window is in", () => {
    // Explicit +1 / -1 boundary sweep: the exact-day tests above plus
    // "just outside" and "just inside" to lock the operator direction.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 1000 },
      { date: "2026-07-25", "live-1": 1050 },
    ];

    // -1 boundary: dated 07-19 (before prev) → OUT.
    const before = computeModeSummary(series, [LIVE], [
      { portfolio_id: "live-1", date: "2026-07-19", amount: 40 },
    ]);
    expect(before?.real.pnl).toBe(50);

    // +1 into window: dated 07-21 → IN. Trading pnl = 50 − 40 = 10.
    const insideStart = computeModeSummary(series, [LIVE], [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 40 },
    ]);
    expect(insideStart?.real.pnl).toBe(10);

    // Exactly the last anchor: 07-25 → IN. Trading pnl = 50 − 40 = 10.
    const onLast = computeModeSummary(series, [LIVE], [
      { portfolio_id: "live-1", date: "2026-07-25", amount: 40 },
    ]);
    expect(onLast?.real.pnl).toBe(10);

    // One day past the last anchor: 07-26 → OUT.
    const afterLast = computeModeSummary(series, [LIVE], [
      { portfolio_id: "live-1", date: "2026-07-26", amount: 40 },
    ]);
    expect(afterLast?.real.pnl).toBe(50);
  });
});
