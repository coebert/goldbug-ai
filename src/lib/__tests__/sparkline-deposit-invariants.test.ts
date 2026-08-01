// Invariant (property-style) tests for the portfolio-card sparkline.
//
// Rules under test, over randomly generated equity series and
// CASH_SYNC broker-log rows:
//
//   1. A row whose `previousStarting` is missing, null or junk is a
//      baseline *repair*. It may only ever be attributed to an equity
//      step the series actually shows, and never more than the broker
//      reported.
//   2. Consequently the card percentage can only ever move between the
//      raw (un-netted) delta and the verbatim-netted delta — it can
//      never be pushed below the phantom-deposit result, which is the
//      "-49%" bug.
//   3. Rows with a real numeric `previousStarting` are trusted cash
//      movements and pass through untouched, whatever the series does.
//
// The generator is a seeded LCG so failures are reproducible and the
// suite is deterministic under parallel runs.

import { describe, expect, it } from "vitest";
import { reanchorInferredInflow, trustedPreviousStarting } from "../infer-cash-flow";
import { computeCardRangePct } from "../card-range-pct";
import {
  CASH_SYNC_PORTFOLIO,
  deriveFlowsFromCashSyncs,
  type CashSyncLogRow,
  type SeriesPoint,
} from "./fixtures/cash-sync";

// ---------- deterministic generators ----------

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const DAY = 86_400_000;
const EPOCH = Date.UTC(2026, 6, 1);
const iso = (dayIndex: number) => new Date(EPOCH + dayIndex * DAY).toISOString().slice(0, 10);

function makeSeries(rand: () => number): SeriesPoint[] {
  const n = 2 + Math.floor(rand() * 12);
  const out: SeriesPoint[] = [];
  let value = 500 + rand() * 20_000;
  for (let i = 0; i < n; i++) {
    // Mix ordinary drift with occasional large funding-shaped jumps.
    const jump = rand() < 0.2 ? rand() * 15_000 : 0;
    value = Math.max(1, value * (0.95 + rand() * 0.1) + jump);
    out.push({ date: iso(i), value: Math.round(value * 100) / 100 });
  }
  return out;
}

const UNTRUSTED_PREV = [undefined, null, "", "   ", "unknown", Number.NaN] as const;

function makeUntrustedRow(rand: () => number, series: SeriesPoint[]): CashSyncLogRow {
  const prev = UNTRUSTED_PREV[Math.floor(rand() * UNTRUSTED_PREV.length)];
  const response: CashSyncLogRow["response"] = {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: Math.round(rand() * 30_000 * 100) / 100,
    newStarting: 10_000,
  };
  if (prev !== undefined) response.previousStarting = prev as never;
  const at = series[Math.floor(rand() * series.length)]?.date ?? iso(0);
  return {
    portfolio_id: CASH_SYNC_PORTFOLIO,
    created_at: `${at}T06:00:00.000Z`,
    status: 200,
    response,
  };
}

function makeTrustedRow(rand: () => number, series: SeriesPoint[]): CashSyncLogRow {
  const prevStart = Math.round(rand() * 10_000 * 100) / 100;
  const delta = Math.round((rand() * 4_000 - 2_000) * 100) / 100 || 100;
  const at = series[Math.floor(rand() * series.length)]?.date ?? iso(0);
  return {
    portfolio_id: CASH_SYNC_PORTFOLIO,
    created_at: `${at}T06:00:00.000Z`,
    status: 200,
    response: {
      startingCashAdjusted: true,
      currency: "GBP",
      delta,
      previousStarting: prevStart,
      newStarting: prevStart + delta,
    },
  };
}

const derive = (rows: CashSyncLogRow[], series: SeriesPoint[]) =>
  deriveFlowsFromCashSyncs(rows, series, reanchorInferredInflow);

function maxPositiveStep(series: SeriesPoint[]): number {
  const clean = [...series].sort((a, b) => (a.date < b.date ? -1 : 1));
  let best = 0;
  for (let i = 1; i < clean.length; i++) best = Math.max(best, clean[i].value - clean[i - 1].value);
  return best;
}

const CASES = Array.from({ length: 200 }, (_, i) => {
  const rand = lcg(0xc0ffee + i * 7919);
  const series = makeSeries(rand);
  return { seed: i, rand, series };
});

// ---------- invariants ----------

describe("sparkline invariants: untrusted cash-syncs never introduce deposits", () => {
  it("an untrusted row is never trusted by trustedPreviousStarting", () => {
    for (const v of UNTRUSTED_PREV) expect(trustedPreviousStarting(v as unknown)).toBeNull();
  });

  it("derived flows are bounded by both the reported delta and the visible step", () => {
    for (const { seed, rand, series } of CASES) {
      const row = makeUntrustedRow(rand, series);
      const flows = derive([row], series);
      const reported = Number(row.response.delta);
      const step = maxPositiveStep(series);
      for (const f of flows) {
        expect(f.amount, `seed ${seed}`).toBeGreaterThan(0);
        expect(f.amount, `seed ${seed}`).toBeLessThanOrEqual(reported + 1e-9);
        expect(f.amount, `seed ${seed}`).toBeLessThanOrEqual(step + 1e-9);
        expect(series.some((p) => p.date === f.date), `seed ${seed}`).toBe(true);
      }
    }
  });

  it("no visible upward step ⇒ no flow at all", () => {
    for (const { seed, rand, series } of CASES) {
      if (maxPositiveStep(series) > 0) continue;
      expect(derive([makeUntrustedRow(rand, series)], series), `seed ${seed}`).toEqual([]);
    }
  });

  it("card % stays between the worst-case phantom netting and the raw delta", () => {
    for (const { seed, rand, series } of CASES) {
      const row = makeUntrustedRow(rand, series);
      const flows = derive([row], series);
      const actual = computeCardRangePct(series, flows, false);
      const raw = computeCardRangePct(series, [], false);
      // Worst case: the full reported delta netted in-window (the "-49%" bug).
      const lastDate = [...series].sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1)!.date;
      const phantom = computeCardRangePct(
        series,
        [{ date: lastDate, amount: Number(row.response.delta) }],
        false,
      );
      expect(actual, `seed ${seed}`).not.toBeNull();
      // Netting an inflow can only reduce the reported gain…
      expect(actual!, `seed ${seed}`).toBeLessThanOrEqual(raw! + 1e-6);
      // …but never below what the phantom deposit would have produced.
      expect(actual!, `seed ${seed}`).toBeGreaterThanOrEqual(phantom! - 1e-6);
    }
  });

  it("a repair can never manufacture a loss on a non-decreasing series", () => {
    for (const { seed, rand, series } of CASES) {
      const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : 1));
      const nonDecreasing = sorted.every((p, i) => i === 0 || p.value >= sorted[i - 1].value);
      if (!nonDecreasing) continue;
      const flows = derive([makeUntrustedRow(rand, sorted)], sorted);
      const pct = computeCardRangePct(sorted, flows, false);
      expect(pct!, `seed ${seed}`).toBeGreaterThan(-1e-6);
    }
  });

  it("is idempotent and order-independent for a single repair", () => {
    for (const { seed, rand, series } of CASES) {
      const row = makeUntrustedRow(rand, series);
      const a = derive([row], series);
      const b = derive([row], [...series].reverse());
      expect(b, `seed ${seed}`).toEqual(a);
      expect(derive([row], series), `seed ${seed}`).toEqual(a);
    }
  });

  it("trusted rows pass through verbatim regardless of the series shape", () => {
    for (const { seed, rand, series } of CASES) {
      const row = makeTrustedRow(rand, series);
      expect(derive([row], series), `seed ${seed}`).toEqual([
        { date: String(row.created_at).slice(0, 10), amount: Number(row.response.delta) },
      ]);
    }
  });

  it("adding a repair alongside trusted rows only ever removes visible gain", () => {
    for (const { seed, rand, series } of CASES) {
      const trusted = makeTrustedRow(rand, series);
      const repair = makeUntrustedRow(rand, series);
      const withoutRepair = computeCardRangePct(series, derive([trusted], series), false);
      const withRepair = computeCardRangePct(series, derive([trusted, repair], series), false);
      expect(withRepair!, `seed ${seed}`).toBeLessThanOrEqual(withoutRepair! + 1e-6);
    }
  });
});
