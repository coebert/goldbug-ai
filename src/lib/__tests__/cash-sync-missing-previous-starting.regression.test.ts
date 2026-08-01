// Regression suite: CASH_SYNC rows that lack a trustworthy
// `previousStarting` must never net phantom deposits out of the equity
// sparkline. Companion to inferred-cash-flow-reanchor.regression.test.ts,
// broadened across the fixture matrix in ./fixtures/cash-sync.ts.

import { describe, expect, it } from "vitest";
import { reanchorInferredInflow } from "../infer-cash-flow";
import { computeCardRangePct } from "../card-range-pct";
import {
  cashSyncRows,
  decliningSeries,
  deriveFlowsFromCashSyncs,
  fundedAtBaselineSeries,
  fundedThenFlatSeries,
  twoStepFundingSeries,
} from "./fixtures/cash-sync";

const derive = (rows: Parameters<typeof deriveFlowsFromCashSyncs>[0], series = fundedThenFlatSeries) =>
  deriveFlowsFromCashSyncs(rows, series, reanchorInferredInflow);

describe("cash-sync rows missing previousStarting", () => {
  it.each([
    ["absent", cashSyncRows.missingPreviousStarting],
    ["null", cashSyncRows.nullPreviousStarting],
    ["non-numeric", cashSyncRows.junkPreviousStarting],
  ])("re-anchors the repair when previousStarting is %s", (_label, row) => {
    const flows = derive([row]);
    expect(flows).toHaveLength(1);
    expect(flows[0].date).toBe("2026-07-24");
    expect(flows[0].amount).toBeCloseTo(8888.8, 6);
    const pct = computeCardRangePct(fundedThenFlatSeries, flows, false);
    expect(Math.abs(pct!)).toBeLessThan(0.01);
  });

  it("never nets more than the equity series actually shows", () => {
    const flows = derive([cashSyncRows.overstatedRepair], twoStepFundingSeries);
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(5000);
    expect(flows[0].date).toBe("2026-07-21");
    const pct = computeCardRangePct(twoStepFundingSeries, flows, false);
    // Remaining +5000 step on 07-23 is not attributed to this flow, so the
    // card is positive — but nowhere near the raw +1900% equity delta.
    expect(pct!).toBeGreaterThan(0);
    expect(pct!).toBeLessThan(2000);
  });

  it("drops the repair entirely on a portfolio that only fell", () => {
    const flows = derive([cashSyncRows.repairOnDecliningPortfolio], decliningSeries);
    expect(flows).toEqual([]);
    const pct = computeCardRangePct(decliningSeries, flows, false);
    expect(pct!).toBeCloseTo(-9, 5);
  });

  it("does not invent a step when funding predates the first snapshot", () => {
    const flows = derive([cashSyncRows.missingPreviousStarting], fundedAtBaselineSeries);
    // The only positive step is a small +12.28 trading move; capping at the
    // observed step keeps the phantom 9,890.38 out of the card.
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBeCloseTo(12.28, 2);
    const pct = computeCardRangePct(fundedAtBaselineSeries, flows, false);
    expect(pct!).toBeGreaterThan(-1);
    expect(pct!).toBeLessThan(0);
  });

  it("keeps trusted flows verbatim", () => {
    expect(derive([cashSyncRows.trustedDeposit], twoStepFundingSeries)).toEqual([
      { date: "2026-07-22", amount: 5000 },
    ]);
    expect(derive([cashSyncRows.trustedWithdrawal])).toEqual([
      { date: "2026-07-22", amount: -250 },
    ]);
  });

  it.each([
    ["clamped no-op", cashSyncRows.clampedNoop],
    ["startingCashAdjusted=false", cashSyncRows.notAdjusted],
    ["zero delta", cashSyncRows.zeroDelta],
    ["non-finite delta", cashSyncRows.nanDelta],
  ])("ignores %s rows", (_label, row) => {
    expect(derive([row])).toEqual([]);
  });

  it("verbatim netting (the old behaviour) is what produced the wrong card", () => {
    const verbatim = [{ date: "2026-07-27", amount: 9890.38 }];
    const wrong = computeCardRangePct(fundedThenFlatSeries, verbatim, false);
    expect(wrong!).toBeLessThan(-5);
  });

  it("mixed log: repairs are re-anchored while trusted rows pass through", () => {
    const flows = derive(
      [
        cashSyncRows.trustedDeposit,
        cashSyncRows.notAdjusted,
        cashSyncRows.zeroDelta,
        cashSyncRows.overstatedRepair,
      ],
      twoStepFundingSeries,
    );
    expect(flows).toEqual([
      { date: "2026-07-22", amount: 5000 },
      { date: "2026-07-21", amount: 5000 },
    ]);
  });
});
