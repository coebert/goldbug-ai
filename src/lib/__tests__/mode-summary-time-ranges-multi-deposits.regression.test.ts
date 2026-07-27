// Regression: % change calculation must stay correct across different
// time-range window slices (7d / 30d / 90d / YTD / ALL) AND across
// multiple deposit and withdrawal events scattered throughout the
// window. Callers typically pre-slice the equity series to the chosen
// range before invoking computeModeSummary — the function then anchors
// `previous` to the first row of the slice and `last` to the last row.
//
// Rules under test:
//   - Deposits dated on/before `prev.date` are ALREADY baked into the
//     starting equity and must NOT be re-netted (no double-counting).
//   - Deposits strictly AFTER prev.date and up to & including last.date
//     are netted out of the numerator, so pure cash-flow contributes 0
//     to pnl/pct regardless of how many events happened.
//   - The denominator is anchored to `previous` (pre-window equity),
//     so the same trading PnL yields the same pct across window
//     lengths — provided the pre-window equity is identical.
//   - Withdrawals (negative amounts) net symmetrically.
//   - Multiple deposits on multiple days inside the window collapse
//     to their sum; ordering and count are irrelevant.

import { describe, expect, it } from "vitest";
import {
  computeModeSummary,
  type DepositEvent,
  type SummaryPortfolio,
  type SummarySeriesRow,
} from "@/lib/mode-summary";

const LIVE: SummaryPortfolio = { id: "live-1", mode: "live_prod" };

// A 90-day synthetic equity series for one live portfolio. The account
// starts at £1,000 on day 0, receives four deposits and one withdrawal
// spread through the window, and earns exactly £90 of trading PnL by
// day 89 (linear ramp of +£1/day for readability). Equity on each day
// = 1000 + cumulativeCashFlow(day) + tradingPnl(day).
const START = 1_000;
const DAYS = 90;
const cashFlows: Array<{ dayIndex: number; amount: number }> = [
  { dayIndex: 5, amount: 200 }, // small top-up
  { dayIndex: 20, amount: 500 }, // mid-window top-up
  { dayIndex: 45, amount: -100 }, // partial withdrawal
  { dayIndex: 60, amount: 1_000 }, // large late deposit
  { dayIndex: 80, amount: 50 }, // trailing top-up
];

const iso = (dayIndex: number) => {
  // 2026-05-01 + dayIndex, all inside a single month-agnostic range.
  const base = new Date(Date.UTC(2026, 4, 1));
  base.setUTCDate(base.getUTCDate() + dayIndex);
  return base.toISOString().slice(0, 10);
};

const cumulativeFlowUpTo = (dayIndex: number) =>
  cashFlows.reduce((s, e) => (e.dayIndex <= dayIndex ? s + e.amount : s), 0);

const tradingPnlAt = (dayIndex: number) => dayIndex; // +£1 per day

const series: SummarySeriesRow[] = Array.from({ length: DAYS }, (_, i) => ({
  date: iso(i),
  "live-1": START + cumulativeFlowUpTo(i) + tradingPnlAt(i),
}));

const deposits: DepositEvent[] = cashFlows.map((e) => ({
  portfolio_id: "live-1",
  date: iso(e.dayIndex),
  amount: e.amount,
}));

const sliceWindow = (fromDayIndex: number, toDayIndex: number) =>
  series.filter((r) => r.date >= iso(fromDayIndex) && r.date <= iso(toDayIndex));

describe("computeModeSummary — % change across time ranges & multi-deposit events", () => {
  it("7-day window: only in-window cash-flows are netted; pnl == trading delta", () => {
    // Slice days 82..88 → prev == day 82, last == day 88.
    // In-window flows (strictly after prev.date, ≤ last.date): none
    // (day 80 deposit is on/before prev.date=82; nothing else fires).
    // Trading delta = (88 − 82) = £6.
    const window = sliceWindow(82, 88);
    const s = computeModeSummary(window, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(6, 10);
    const previous = START + cumulativeFlowUpTo(82) + tradingPnlAt(82);
    expect(s?.real.pct).toBeCloseTo((6 / previous) * 100, 10);
  });

  it("30-day window straddling one deposit: deposit is netted out of pnl/pct", () => {
    // Slice days 55..85 → prev == day 55, last == day 85.
    // In-window flows: day 60 (+1000), day 80 (+50) = +£1050.
    // Trading delta over the window = 85 − 55 = £30.
    // Raw equity delta = 1050 + 30 = £1080; netting deposits → £30 pnl.
    const window = sliceWindow(55, 85);
    const s = computeModeSummary(window, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(30, 10);
    const previous = START + cumulativeFlowUpTo(55) + tradingPnlAt(55);
    expect(s?.real.pct).toBeCloseTo((30 / previous) * 100, 10);
  });

  it("90-day (ALL) window with 4 deposits + 1 withdrawal: pnl == pure trading PnL", () => {
    // Full series → prev == day 0, last == day 89.
    // Every cash-flow event falls strictly after prev.date, so all
    // £1650 net cash is netted. Trading PnL = day 89 − day 0 = £89.
    const s = computeModeSummary(series, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(89, 10);
    // Denominator anchored to pre-window equity (day 0 = £1000).
    expect(s?.real.pct).toBeCloseTo((89 / START) * 100, 10);
  });

  it("pct is invariant across window lengths when trading PnL/day is constant", () => {
    // With +£1/day trading PnL and a fixed £1000 anchor at day 0, any
    // window that starts at day 0 must yield pct = (windowLen−1)/1000 %.
    for (const end of [10, 30, 60, 89]) {
      const window = sliceWindow(0, end);
      const s = computeModeSummary(window, [LIVE], deposits);
      expect(s?.real.pnl).toBeCloseTo(end, 10);
      expect(s?.real.pct).toBeCloseTo((end / START) * 100, 10);
    }
  });

  it("withdrawal-only window: negative cash-flow is netted symmetrically → pnl == trading only", () => {
    // Slice days 40..50 → covers the −£100 withdrawal on day 45.
    // Trading delta = 50 − 40 = £10. Raw equity delta = 10 − 100 = −£90.
    // Netting → pnl = £10, positive, unaffected by the withdrawal.
    const window = sliceWindow(40, 50);
    const s = computeModeSummary(window, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(10, 10);
    const previous = START + cumulativeFlowUpTo(40) + tradingPnlAt(40);
    expect(s?.real.pct).toBeCloseTo((10 / previous) * 100, 10);
  });

  it("multiple deposits on the SAME day inside window collapse to their sum", () => {
    // Two extra £250 deposits on day 70 (in addition to day-60 £1000,
    // day-80 £50 already in fixture). Slice 55..85. All three in-window
    // events sum to 1000 + 250 + 250 + 50 = £1550. Trading delta = £30.
    const extra: DepositEvent[] = [
      { portfolio_id: "live-1", date: iso(70), amount: 250 },
      { portfolio_id: "live-1", date: iso(70), amount: 250 },
    ];
    const localSeries: SummarySeriesRow[] = series.map((r) => {
      const day = Math.floor(
        (Date.parse(r.date) - Date.parse(iso(0))) / (24 * 3600 * 1000),
      );
      const extraFlow = day >= 70 ? 500 : 0;
      return { ...r, "live-1": Number(r["live-1"]) + extraFlow };
    });
    const window = localSeries.filter(
      (r) => r.date >= iso(55) && r.date <= iso(85),
    );
    const s = computeModeSummary(window, [LIVE], [...deposits, ...extra]);
    expect(s?.real.pnl).toBeCloseTo(30, 10);
  });

  it("deposits dated on/before prev.date are NOT re-netted (no double-count)", () => {
    // Slice days 25..40 → prev == day 25. The day-20 £500 deposit is
    // baked into the starting equity and must be ignored. Only the
    // trading delta (40 − 25 = £15) remains.
    const window = sliceWindow(25, 40);
    const s = computeModeSummary(window, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(15, 10);
    const previous = START + cumulativeFlowUpTo(25) + tradingPnlAt(25);
    expect(s?.real.pct).toBeCloseTo((15 / previous) * 100, 10);
  });

  it("deposit dated exactly on last.date IS netted (inclusive right edge)", () => {
    // Slice days 55..60 → last == day 60, which is a deposit day (+£1000).
    // Trading delta = 60 − 55 = £5. Raw = 5 + 1000. Netting → pnl = £5.
    const window = sliceWindow(55, 60);
    const s = computeModeSummary(window, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(5, 10);
  });

  it("deposit dated exactly on prev.date is NOT netted (exclusive left edge)", () => {
    // Slice days 60..65 → prev == day 60 (a deposit day). Its £1000 is
    // in `previous` already; do not net again. Trading delta = £5.
    const window = sliceWindow(60, 65);
    const s = computeModeSummary(window, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(5, 10);
    const previous = START + cumulativeFlowUpTo(60) + tradingPnlAt(60);
    expect(s?.real.pct).toBeCloseTo((5 / previous) * 100, 10);
  });

  it("includeDeposits:true across a multi-deposit window returns RAW equity change", () => {
    // Opt-in raw view: pnl == now − previous with no netting, whatever
    // the deposit count. Slice days 0..89.
    const s = computeModeSummary(series, [LIVE], deposits, { includeDeposits: true });
    const previous = START + cumulativeFlowUpTo(0) + tradingPnlAt(0);
    const now = START + cumulativeFlowUpTo(89) + tradingPnlAt(89);
    expect(s?.real.pnl).toBeCloseTo(now - previous, 10);
    expect(s?.real.pct).toBeCloseTo(((now - previous) / previous) * 100, 10);
  });
});
