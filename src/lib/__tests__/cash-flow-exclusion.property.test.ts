// Property-based tests: no matter what random sequence of trading PnL
// and cash-flows (deposits/withdrawals) we generate, every equity %
// surface that powers cards and charts MUST report identical numbers
// to the same series *without* the flows.
//
// The three surfaces under test:
//   1. computeDailyEquityChanges — the per-day bar chart on the
//      portfolio route.
//   2. computeCardRangePct       — the trailing-range badge on the
//      home-page portfolio card.
//   3. computeModeSummary        — the dashboard mode tile (sim/real
//      last-two-snapshot summary).
//
// The core invariant we're locking in with property testing:
//
//     surface(equityWithFlows, flows)  ≡  surface(equityWithoutFlows, [])
//
// for random shapes of both inputs. This catches any regression where
// a deposit or withdrawal leaks into the pnl / pct — the class of bug
// that produced the +1101% Balanced-sim reading.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeDailyEquityChanges } from "../daily-equity-changes";
import { computeCardRangePct } from "../card-range-pct";
import {
  computeModeSummary,
  type DepositEvent,
  type SummarySeriesRow,
} from "../mode-summary";

// ---------- helpers ----------

const isoDate = (offsetDays: number): string => {
  // Deterministic anchor so shrunk counter-examples are reproducible.
  const anchor = Date.UTC(2026, 0, 1); // 2026-01-01
  const d = new Date(anchor + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
};

type Trace = {
  /** N+1 snapshot values (index 0 = baseline day). */
  visibleEquity: number[];
  /** Same length, the trading-only equity (flows removed). */
  tradingEquity: number[];
  /** Signed flows keyed by day index (0..N). Never on the baseline day. */
  flowsByDay: Map<number, number>;
};

/**
 * Build two parallel equity series over `days` days starting from
 * `baseline`:
 *   - tradingEquity[i] = baseline + Σ tradePnl[1..i]
 *   - visibleEquity[i] = tradingEquity[i] + Σ flow[1..i]
 * The flows array is (dayIndex, amount) pairs. Flows on day 0 are
 * dropped because they'd be baked into the baseline anyway.
 */
function buildTrace(
  baseline: number,
  tradePnl: number[],
  flows: { day: number; amount: number }[],
): Trace {
  const days = tradePnl.length;
  const flowsByDay = new Map<number, number>();
  for (const f of flows) {
    if (f.day <= 0 || f.day > days) continue;
    flowsByDay.set(f.day, (flowsByDay.get(f.day) ?? 0) + f.amount);
  }
  const tradingEquity: number[] = [baseline];
  const visibleEquity: number[] = [baseline];
  let vis = baseline;
  let trd = baseline;
  for (let i = 1; i <= days; i++) {
    trd += tradePnl[i - 1];
    vis += tradePnl[i - 1] + (flowsByDay.get(i) ?? 0);
    tradingEquity.push(trd);
    visibleEquity.push(vis);
  }
  return { tradingEquity, visibleEquity, flowsByDay };
}

// ---------- arbitraries ----------

const tradePnlArb = fc.double({
  min: -75,
  max: 75,
  noNaN: true,
  noDefaultInfinity: true,
});

// Baseline strictly > 0 and comfortably above the worst-case cumulative
// trading loss so `prev` in the daily computation never drops to 0
// (which would zero the pct by definition and mask leaks).
const baselineArb = fc.double({
  min: 5_000,
  max: 50_000,
  noNaN: true,
  noDefaultInfinity: true,
});

const traceArb = (opts: { minDays?: number; maxDays?: number } = {}) =>
  fc
    .record({
      baseline: baselineArb,
      tradePnl: fc.array(tradePnlArb, {
        minLength: opts.minDays ?? 2,
        maxLength: opts.maxDays ?? 20,
      }),
      flows: fc.array(
        fc.record({
          day: fc.integer({ min: 1, max: opts.maxDays ?? 20 }),
          amount: fc
            .double({
              min: -2_000,
              max: 2_000,
              noNaN: true,
              noDefaultInfinity: true,
            })
            .filter((a) => Math.abs(a) > 0.5), // avoid degenerate 0-amount noise
        }),
        { maxLength: 15 },
      ),
    })
    .map(({ baseline, tradePnl, flows }) => ({
      baseline,
      tradePnl,
      flows,
      trace: buildTrace(baseline, tradePnl, flows),
    }));

// ---------- 1. computeDailyEquityChanges ----------

describe("property: computeDailyEquityChanges excludes cash flows", () => {
  it("per-day pnl/pct matches the trading-only series regardless of flows", () => {
    fc.assert(
      fc.property(traceArb(), ({ trace }) => {
        const withFlows = trace.visibleEquity.map((v, i) => ({
          snapshot_date: isoDate(i),
          total_value: v,
        }));
        const withoutFlows = trace.tradingEquity.map((v, i) => ({
          snapshot_date: isoDate(i),
          total_value: v,
        }));
        const deposits = [...trace.flowsByDay.entries()].map(([day, amount]) => ({
          date: isoDate(day),
          amount,
        }));

        const observed = computeDailyEquityChanges(withFlows, deposits);
        const oracle = computeDailyEquityChanges(withoutFlows, []);
        expect(observed).toHaveLength(oracle.length);
        for (let i = 0; i < observed.length; i++) {
          expect(observed[i].pnl).toBeCloseTo(oracle[i].pnl, 6);
          expect(observed[i].pct).toBeCloseTo(oracle[i].pct, 9);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("pure-flow days (no trading pnl) always yield pct=0 and pnl=0", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            day: fc.integer({ min: 1, max: 10 }),
            amount: fc
              .double({
                min: -3_000,
                max: 3_000,
                noNaN: true,
                noDefaultInfinity: true,
              })
              .filter((a) => Math.abs(a) > 0.5),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        baselineArb,
        (flows, baseline) => {
          // No trading PnL — all daily deltas are pure cash-flow.
          const trace = buildTrace(baseline, Array(10).fill(0), flows);
          const equity = trace.visibleEquity.map((v, i) => ({
            snapshot_date: isoDate(i),
            total_value: v,
          }));
          const deposits = [...trace.flowsByDay.entries()].map(
            ([day, amount]) => ({ date: isoDate(day), amount }),
          );
          const rows = computeDailyEquityChanges(equity, deposits);
          for (const r of rows) {
            expect(r.pnl).toBeCloseTo(0, 6);
            expect(r.pct).toBeCloseTo(0, 9);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------- 2. computeCardRangePct ----------

describe("property: computeCardRangePct excludes cash flows", () => {
  it("range % matches the trading-only series regardless of flows", () => {
    fc.assert(
      fc.property(traceArb({ minDays: 1, maxDays: 20 }), ({ trace }) => {
        const withFlows = trace.visibleEquity.map((v, i) => ({
          date: isoDate(i),
          value: v,
        }));
        const withoutFlows = trace.tradingEquity.map((v, i) => ({
          date: isoDate(i),
          value: v,
        }));
        const deposits = [...trace.flowsByDay.entries()].map(([day, amount]) => ({
          date: isoDate(day),
          amount,
        }));

        const observed = computeCardRangePct(withFlows, deposits, false);
        const oracle = computeCardRangePct(withoutFlows, [], false);
        if (observed === null || oracle === null) {
          expect(observed).toBe(oracle);
          return;
        }
        expect(observed).toBeCloseTo(oracle, 6);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- 3. computeModeSummary ----------

describe("property: computeModeSummary excludes cash flows", () => {
  it("last-window pnl/pct matches the trading-only series regardless of flows", () => {
    fc.assert(
      fc.property(traceArb({ minDays: 2, maxDays: 15 }), ({ trace }) => {
        const pid = "port-A";
        const withFlows: SummarySeriesRow[] = trace.visibleEquity.map((v, i) => ({
          date: isoDate(i),
          [pid]: v,
        }));
        const withoutFlows: SummarySeriesRow[] = trace.tradingEquity.map(
          (v, i) => ({ date: isoDate(i), [pid]: v }),
        );
        const portfolios = [{ id: pid, mode: "sim" as const }];
        const deposits: DepositEvent[] = [...trace.flowsByDay.entries()].map(
          ([day, amount]) => ({ portfolio_id: pid, date: isoDate(day), amount }),
        );

        const observed = computeModeSummary(withFlows, portfolios, deposits);
        const oracle = computeModeSummary(withoutFlows, portfolios, []);
        expect(observed).not.toBeNull();
        expect(oracle).not.toBeNull();
        expect(observed!.sim.pnl).toBeCloseTo(oracle!.sim.pnl, 6);
        expect(observed!.sim.pct).toBeCloseTo(oracle!.sim.pct, 9);
      }),
      { numRuns: 200 },
    );
  });

  it("pure-flow-only history reports pnl=0 and pct=0 for the last window", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            day: fc.integer({ min: 1, max: 8 }),
            amount: fc
              .double({
                min: -5_000,
                max: 5_000,
                noNaN: true,
                noDefaultInfinity: true,
              })
              .filter((a) => Math.abs(a) > 0.5),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        baselineArb,
        (flows, baseline) => {
          const trace = buildTrace(baseline, Array(8).fill(0), flows);
          const pid = "port-A";
          const rows: SummarySeriesRow[] = trace.visibleEquity.map((v, i) => ({
            date: isoDate(i),
            [pid]: v,
          }));
          const deposits: DepositEvent[] = [...trace.flowsByDay.entries()].map(
            ([day, amount]) => ({ portfolio_id: pid, date: isoDate(day), amount }),
          );
          const summary = computeModeSummary(
            rows,
            [{ id: pid, mode: "sim" }],
            deposits,
          );
          expect(summary).not.toBeNull();
          expect(summary!.sim.pnl).toBeCloseTo(0, 6);
          expect(summary!.sim.pct).toBeCloseTo(0, 9);
        },
      ),
      { numRuns: 200 },
    );
  });
});
