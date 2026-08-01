// Regression: a broker CASH_SYNC that repairs an unknown `starting_cash`
// baseline must not be netted out of the sparkline as if that much money
// had arrived on the day the sync noticed.
//
// Real data (portfolio 7c825889…, 2026-08-01): equity 1,300.32 on 07-23,
// 10,189.12 from 07-24 onwards, and a CASH_SYNC on 07-27 reporting a
// 9,890.38 delta with previousStarting = null. Verbatim netting produced
// a −8.95% card (earlier snapshot shapes produced −49%), while the
// portfolio had in fact been flat since the money landed.

import { describe, expect, it } from "vitest";
import { reanchorInferredInflow } from "../infer-cash-flow";
import { computeCardRangePct } from "../card-range-pct";

const SERIES = [
  { date: "2026-07-23", value: 1300.32 },
  { date: "2026-07-24", value: 10189.12 },
  { date: "2026-07-27", value: 10189.12 },
  { date: "2026-07-28", value: 10189.12 },
  { date: "2026-08-01", value: 10189.12 },
];

describe("inferred cash-flow re-anchoring", () => {
  it("re-anchors an untrusted delta onto the observed equity step", () => {
    const flow = reanchorInferredInflow({ date: "2026-07-27", amount: 9890.38 }, SERIES);
    expect(flow).toEqual({ date: "2026-07-24", amount: 8888.8 });
  });

  it("card % is ~0 for a portfolio that has been flat since funding", () => {
    const flow = reanchorInferredInflow({ date: "2026-07-27", amount: 9890.38 }, SERIES)!;
    const pct = computeCardRangePct(SERIES, [flow], false);
    expect(pct).not.toBeNull();
    expect(Math.abs(pct!)).toBeLessThan(0.01);
  });

  it("verbatim netting is what produced the wrong number (guard for the fix)", () => {
    const wrong = computeCardRangePct(SERIES, [{ date: "2026-07-27", amount: 9890.38 }], false);
    expect(wrong!).toBeLessThan(-5);
  });

  it("never claims more than the broker reported", () => {
    const flow = reanchorInferredInflow({ date: "2026-07-27", amount: 500 }, SERIES);
    expect(flow).toEqual({ date: "2026-07-24", amount: 500 });
  });

  it("drops the flow when the series shows no inflow at all", () => {
    const falling = [
      { date: "2026-07-23", value: 10000 },
      { date: "2026-07-24", value: 9500 },
    ];
    expect(reanchorInferredInflow({ date: "2026-07-27", amount: 1000 }, falling)).toBeNull();
  });

  it("passes the record through when there is not enough series to judge", () => {
    const one = [{ date: "2026-07-23", value: 10000 }];
    expect(reanchorInferredInflow({ date: "2026-07-27", amount: 1000 }, one)).toEqual({
      date: "2026-07-27",
      amount: 1000,
    });
  });

  it("ignores non-positive or non-finite deltas", () => {
    expect(reanchorInferredInflow({ date: "2026-07-27", amount: 0 }, SERIES)).toBeNull();
    expect(reanchorInferredInflow({ date: "2026-07-27", amount: Number.NaN }, SERIES)).toBeNull();
  });
});
