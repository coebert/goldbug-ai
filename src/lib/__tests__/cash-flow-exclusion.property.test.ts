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
  it("per-day trading pnl matches the flow-free series regardless of flows", () => {
    // The exclusion contract is on `pnl` (the numerator) — the % is
    // then pnl/prev, and prev legitimately shifts when flows move
    // the equity level. So we lock pnl parity and separately assert
    // pct is derived from the observed pnl / prev.
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
          // pnl must be the trading-only delta — flows fully excluded.
          expect(observed[i].pnl).toBeCloseTo(oracle[i].pnl, 6);
          // pct must derive from that pnl over the observed prev
          // equity (never from rawDelta).
          const expectedPct =
            observed[i].prevEquity > 0
              ? (observed[i].pnl / observed[i].prevEquity) * 100
              : 0;
          expect(observed[i].pct).toBeCloseTo(expectedPct, 9);
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
  // The card badge uses the capital-adjusted formula
  //   pct = tradingPnl / (baseline + netFlow) * 100
  // so the returned pct with flows differs from the flow-free oracle
  // only by a denominator shift. We lock two invariants:
  //   (a) it never equals the raw includeDeposits=true value when
  //       flows are material — i.e. the flow was actually excluded;
  //   (b) it is invariant under permuting flow event ordering — i.e.
  //       only the netFlow (not its distribution) matters.
  it("excluded pct differs from raw pct and is order-invariant", () => {
    fc.assert(
      fc.property(traceArb({ minDays: 2, maxDays: 20 }), ({ trace }) => {
        const withFlows = trace.visibleEquity.map((v, i) => ({
          date: isoDate(i),
          value: v,
        }));
        const deposits = [...trace.flowsByDay.entries()].map(([day, amount]) => ({
          date: isoDate(day),
          amount,
        }));
        const reversed = [...deposits].reverse();

        const excluded = computeCardRangePct(withFlows, deposits, false);
        const excludedReordered = computeCardRangePct(withFlows, reversed, false);
        const included = computeCardRangePct(withFlows, deposits, true);

        // Order-invariance: same set of flows in any order → same pct.
        if (excluded !== null && excludedReordered !== null) {
          expect(excluded).toBeCloseTo(excludedReordered, 9);
        } else {
          expect(excluded).toBe(excludedReordered);
        }

        // If the sum of flows is materially non-zero, the excluded
        // pct MUST differ from the raw pct — otherwise the flow leaked
        // through unchanged.
        const netFlow = [...trace.flowsByDay.values()].reduce((s, a) => s + a, 0);
        const baseline = trace.visibleEquity[0];
        if (
          excluded !== null &&
          included !== null &&
          Math.abs(netFlow) > baseline * 1e-3
        ) {
          expect(excluded).not.toBeCloseTo(included, 3);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- 3. computeModeSummary ----------

describe("property: computeModeSummary excludes cash flows", () => {
  it("trading pnl matches the flow-free series regardless of flows", () => {
    // As with the daily chart, the exclusion contract is on pnl; pct
    // is then pnl / (previous + netFlow), and previous legitimately
    // shifts with flows. Lock pnl parity + pct = capital-adjusted
    // formula so no code path can quietly revert to raw math.
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

        // pnl: strict flow exclusion.
        expect(observed!.sim.pnl).toBeCloseTo(oracle!.sim.pnl, 6);

        // pct: derived from capital-adjusted denominator only.
        // Reconstruct netFlow between the last two snapshots.
        const lastIdx = trace.visibleEquity.length - 1;
        const netFlowLast = trace.flowsByDay.get(lastIdx) ?? 0;
        const previous = trace.visibleEquity[lastIdx - 1];
        const denom = previous + netFlowLast;
        const expectedPct =
          previous > 0 && denom > 0
            ? (observed!.sim.pnl / denom) * 100
            : previous > 0
              ? (observed!.sim.pnl / previous) * 100
              : 0;
        expect(observed!.sim.pct).toBeCloseTo(expectedPct, 6);
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
