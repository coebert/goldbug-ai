// Regression suite: when the equity series contains NO positive step to
// re-anchor onto, an untrusted CASH_SYNC repair must be DROPPED, never
// netted verbatim. Netting it would subtract capital the series never
// shows arriving and fabricate a large loss on the portfolio card
// (the "-49% / -8.9% phantom deposit" bug).
//
// Companion to cash-sync-missing-previous-starting.regression.test.ts,
// which covers the case where a step does exist.

import { describe, expect, it } from "vitest";
import { reanchorInferredInflow } from "../infer-cash-flow";
import { computeCardRangePct } from "../card-range-pct";
import {
  cashSyncRows,
  corruptSeries,
  declineThenFlatSeries,
  decliningSeries,
  deriveFlowsFromCashSyncs,
  emptySeries,
  flatSeries,
  singlePointSeries,
  steadyDeclineSeries,
  unsortedDeclineSeries,
  type SeriesPoint,
} from "./fixtures/cash-sync";

const derive = (rows: Parameters<typeof deriveFlowsFromCashSyncs>[0], series: SeriesPoint[]) =>
  deriveFlowsFromCashSyncs(rows, series, reanchorInferredInflow);

const noStepSeries: Array<[string, SeriesPoint[]]> = [
  ["perfectly flat", flatSeries],
  ["steady decline", steadyDeclineSeries],
  ["decline then flat", declineThenFlatSeries],
  ["unsorted decline", unsortedDeclineSeries],
  ["short decline", decliningSeries],
];

describe("cash-sync re-anchoring with no observable equity step", () => {
  it.each(noStepSeries)("drops an untrusted inflow on a %s series", (_label, series) => {
    expect(reanchorInferredInflow({ date: "2026-07-27", amount: 9890.38 }, series)).toBeNull();
  });

  it.each(noStepSeries)("derives no flow at all from a %s series", (_label, series) => {
    expect(derive([cashSyncRows.missingPreviousStarting], series)).toEqual([]);
    expect(derive([cashSyncRows.nullPreviousStarting], series)).toEqual([]);
    expect(derive([cashSyncRows.junkPreviousStarting], series)).toEqual([]);
  });

  it.each(noStepSeries)("card %% equals the raw equity delta on a %s series", (_label, series) => {
    const flows = derive([cashSyncRows.missingPreviousStarting], series);
    const withFlow = computeCardRangePct(series, flows, false);
    const raw = computeCardRangePct(series, [], false);
    expect(withFlow).toBeCloseTo(raw!, 10);
  });

  it("never turns a flat portfolio into a loss", () => {
    const flows = derive([cashSyncRows.missingPreviousStarting], flatSeries);
    expect(computeCardRangePct(flatSeries, flows, false)).toBeCloseTo(0, 10);
    // What the un-fixed code did:
    const verbatim = [{ date: "2026-07-27", amount: 9890.38 }];
    expect(computeCardRangePct(flatSeries, verbatim, false)!).toBeLessThan(-50);
  });

  it("never deepens a genuine decline", () => {
    const flows = derive([cashSyncRows.repairOnDecliningPortfolio], steadyDeclineSeries);
    expect(flows).toEqual([]);
    const pct = computeCardRangePct(steadyDeclineSeries, flows, false);
    expect(pct!).toBeCloseTo((11000 / 12000 - 1) * 100, 10);
    const verbatim = computeCardRangePct(
      steadyDeclineSeries,
      [{ date: "2026-07-23", amount: 1000 }],
      false,
    );
    expect(verbatim!).toBeLessThan(pct!);
  });

  it("still nets trusted movements even when no step is visible", () => {
    // A real before/after cash movement is never re-anchored.
    expect(derive([cashSyncRows.trustedWithdrawal], flatSeries)).toEqual([
      { date: "2026-07-22", amount: -250 },
    ]);
    expect(derive([cashSyncRows.trustedDeposit], decliningSeries)).toEqual([
      { date: "2026-07-22", amount: 5000 },
    ]);
  });

  describe("series too small or too corrupt to judge", () => {
    it.each([
      ["single point", singlePointSeries],
      ["empty", emptySeries],
      ["all values non-numeric", corruptSeries],
    ])("passes the record through unchanged on a %s series", (_label, series) => {
      const reported = { date: "2026-07-27", amount: 9890.38 };
      expect(reanchorInferredInflow(reported, series)).toEqual(reported);
    });

    it("pass-through is inert: such series render no card percentage change", () => {
      const flows = derive([cashSyncRows.missingPreviousStarting], singlePointSeries);
      expect(flows).toHaveLength(1);
      // One point = baseline only, so the card shows 0% either way.
      expect(computeCardRangePct(singlePointSeries, flows, false)).toBeCloseTo(0, 10);
      expect(computeCardRangePct(emptySeries, flows, false)).toBeNull();
    });
  });

  it("mixed log on a no-step series keeps only the trusted rows", () => {
    const flows = derive(
      [
        cashSyncRows.trustedDeposit,
        cashSyncRows.missingPreviousStarting,
        cashSyncRows.overstatedRepair,
        cashSyncRows.notAdjusted,
      ],
      declineThenFlatSeries,
    );
    expect(flows).toEqual([{ date: "2026-07-22", amount: 5000 }]);
  });
});
