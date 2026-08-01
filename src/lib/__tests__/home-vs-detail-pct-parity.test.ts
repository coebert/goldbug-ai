// Parity assertions: the HOME equity card % and the PORTFOLIO DETAIL
// sparkline % must agree, especially when a CASH_SYNC repair row has no
// trustworthy `previousStarting` and therefore no re-anchorable equity
// step.
//
// The two surfaces build their deposit lists in different loops:
//   - home list:   src/lib/portfolios.functions.ts (~L180-230), keyed by
//                  portfolio via `perPortfolioSeries`
//   - detail page: src/lib/portfolios.functions.ts (~L380-405), single
//                  `ownSeries`
// and then render through different helpers (`deriveCardEquity` vs a
// direct `computeCardRangePct`). Those paths are mirrored here so any
// future divergence in gating (null/junk previousStarting, clamped
// no-ops, missing step) fails this test instead of shipping two
// different percentages for the same portfolio.

import { describe, expect, it } from "vitest";
import { computeCardRangePct } from "../card-range-pct";
import { deriveCardEquity } from "../derive-card-equity";
import { reanchorInferredInflow, trustedPreviousStarting } from "../infer-cash-flow";
import {
  CASH_SYNC_PORTFOLIO,
  cashSyncRows,
  declineThenFlatSeries,
  decliningSeries,
  flatSeries,
  fundedAtBaselineSeries,
  fundedThenFlatSeries,
  singlePointSeries,
  steadyDeclineSeries,
  twoStepFundingSeries,
  unsortedDeclineSeries,
  type CashSyncLogRow,
  type SeriesPoint,
} from "./fixtures/cash-sync";

type Flow = { date: string; amount: number };

/** Mirrors the home-page (portfolio list) deposit derivation. */
function homeDeposits(rows: readonly CashSyncLogRow[], series: SeriesPoint[]): Flow[] {
  const out: Flow[] = [];
  for (const row of rows) {
    if (!row.created_at) continue;
    const resp = row.response ?? {};
    if (!resp.startingCashAdjusted) continue;
    const prevStart = trustedPreviousStarting(resp.previousStarting) ?? Number.NaN;
    const newStart = Number(resp.newStarting);
    if (Number.isFinite(prevStart) && Number.isFinite(newStart) && prevStart === newStart) continue;
    const amt = Number(resp.delta);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const raw = { date: String(row.created_at).slice(0, 10), amount: amt };
    const flow = Number.isFinite(prevStart) ? raw : reanchorInferredInflow(raw, series);
    if (!flow) continue;
    out.push({ date: flow.date, amount: flow.amount });
  }
  return out;
}

/** Mirrors the portfolio-detail deposit derivation. */
function detailDeposits(rows: readonly CashSyncLogRow[], ownSeries: SeriesPoint[]): Flow[] {
  const out: Flow[] = [];
  for (const row of rows) {
    if (!row.created_at) continue;
    const resp = row.response ?? {};
    if (!resp.startingCashAdjusted) continue;
    const prevStart = trustedPreviousStarting(resp.previousStarting);
    const newStart = Number(resp.newStarting);
    if (prevStart !== null && Number.isFinite(newStart) && prevStart === newStart) continue;
    const amt = Number(resp.delta);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const raw = { date: String(row.created_at).slice(0, 10), amount: amt };
    const flow = prevStart !== null ? raw : reanchorInferredInflow(raw, ownSeries);
    if (!flow) continue;
    out.push(flow);
  }
  return out;
}

/** Home card: equity headline + % come from deriveCardEquity. */
function homeCardPct(series: SeriesPoint[], rows: readonly CashSyncLogRow[]) {
  const deposits = homeDeposits(rows, series);
  return deriveCardEquity(series, series, deposits, false, 0).rangePct;
}

/** Detail page: sparkline % comes straight from computeCardRangePct. */
function detailSparkPct(series: SeriesPoint[], rows: readonly CashSyncLogRow[]) {
  return computeCardRangePct(series, detailDeposits(rows, series), false);
}

const SERIES: Array<[string, SeriesPoint[]]> = [
  ["funded then flat", fundedThenFlatSeries],
  ["two-step funding", twoStepFundingSeries],
  ["declining", decliningSeries],
  ["funded at baseline", fundedAtBaselineSeries],
  ["flat (no step)", flatSeries],
  ["steady decline (no step)", steadyDeclineSeries],
  ["decline then flat (no step)", declineThenFlatSeries],
  ["unsorted decline (no step)", unsortedDeclineSeries],
  ["single point", singlePointSeries],
];

const UNTRUSTED: Array<[string, CashSyncLogRow]> = [
  ["missing previousStarting", cashSyncRows.missingPreviousStarting],
  ["null previousStarting", cashSyncRows.nullPreviousStarting],
  ["junk previousStarting", cashSyncRows.junkPreviousStarting],
  ["overstated repair", cashSyncRows.overstatedRepair],
  ["repair on declining portfolio", cashSyncRows.repairOnDecliningPortfolio],
];

const near = (a: number | null, b: number | null) => {
  if (a === null || b === null) {
    expect(a).toBe(b);
    return;
  }
  expect(a).toBeCloseTo(b, 9);
};

describe("home card % vs detail sparkline % parity (missing re-anchor step)", () => {
  for (const [seriesName, series] of SERIES) {
    for (const [rowName, row] of UNTRUSTED) {
      it(`agrees on "${seriesName}" with ${rowName}`, () => {
        near(homeCardPct(series, [row]), detailSparkPct(series, [row]));
      });
    }
  }

  it("agrees when several untrusted repairs stack on a no-step series", () => {
    const rows = [
      cashSyncRows.missingPreviousStarting,
      cashSyncRows.nullPreviousStarting,
      cashSyncRows.overstatedRepair,
    ];
    for (const [, series] of SERIES) {
      near(homeCardPct(series, rows), detailSparkPct(series, rows));
    }
  });

  it("agrees when trusted and untrusted rows are mixed", () => {
    const rows = [
      cashSyncRows.trustedDeposit,
      cashSyncRows.trustedWithdrawal,
      cashSyncRows.clampedNoop,
      cashSyncRows.missingPreviousStarting,
      cashSyncRows.notAdjusted,
      cashSyncRows.zeroDelta,
      cashSyncRows.nanDelta,
    ];
    for (const [, series] of SERIES) {
      near(homeCardPct(series, rows), detailSparkPct(series, rows));
    }
  });

  it("both surfaces drop the repair entirely when no equity step exists", () => {
    for (const series of [flatSeries, steadyDeclineSeries, declineThenFlatSeries]) {
      for (const [, row] of UNTRUSTED) {
        expect(homeDeposits([row], series)).toEqual([]);
        expect(detailDeposits([row], series)).toEqual([]);
        // …so both percentages equal the un-netted, purely visible delta.
        const raw = computeCardRangePct(series, [], false);
        near(homeCardPct(series, [row]), raw);
        near(detailSparkPct(series, [row]), raw);
      }
    }
  });

  it("neither surface shows a fabricated loss on a flat portfolio", () => {
    for (const [, row] of UNTRUSTED) {
      expect(homeCardPct(flatSeries, [row])).toBeCloseTo(0, 9);
      expect(detailSparkPct(flatSeries, [row])).toBeCloseTo(0, 9);
    }
  });

  it("both surfaces re-anchor identically when a step IS available", () => {
    const row = cashSyncRows.missingPreviousStarting;
    expect(homeDeposits([row], fundedThenFlatSeries)).toEqual(
      detailDeposits([row], fundedThenFlatSeries),
    );
    expect(homeDeposits([row], fundedThenFlatSeries).length).toBe(1);
    near(
      homeCardPct(fundedThenFlatSeries, [row]),
      detailSparkPct(fundedThenFlatSeries, [row]),
    );
  });

  it("home-list scoping does not leak another portfolio's rows into the card", () => {
    const foreign: CashSyncLogRow = {
      ...cashSyncRows.missingPreviousStarting,
      portfolio_id: "00000000-0000-4000-8000-0000000000ff",
    };
    const own = cashSyncRows.missingPreviousStarting;
    expect(own.portfolio_id).toBe(CASH_SYNC_PORTFOLIO);
    const scoped = [own, foreign].filter((r) => r.portfolio_id === CASH_SYNC_PORTFOLIO);
    near(
      homeCardPct(fundedThenFlatSeries, scoped),
      detailSparkPct(fundedThenFlatSeries, [own]),
    );
  });
});
