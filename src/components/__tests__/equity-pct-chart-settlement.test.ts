import { describe, expect, it } from "vitest";
import { splitSettledSeries } from "@/components/equity-pct-chart";
import type { SettlementState } from "@/lib/snapshot-settlement";

const pt = (at: string, pct: number) => ({
  at,
  value: 100 + pct,
  pct,
  deltaPct: 0,
  deltaValue: 0,
});

describe("splitSettledSeries", () => {
  it("draws settled points solid and the provisional tail dashed", () => {
    const rows = [pt("2026-08-01", 1), pt("2026-08-03", 2), pt("2026-08-04", 3)];
    const states: SettlementState[] = ["settled", "settled", "intraday"];
    const out = splitSettledSeries(rows, states);

    expect(out.map((r) => r.pctSettled)).toEqual([1, 2, null]);
    // The last settled point is repeated so the dashed tail joins the line.
    expect(out.map((r) => r.pctProvisional)).toEqual([null, 2, 3]);
  });

  it("marks reconstructed interior days as provisional too", () => {
    const rows = [pt("a", 1), pt("b", 2), pt("c", 3)];
    const out = splitSettledSeries(rows, ["settled", "reconstructed", "settled"]);
    expect(out.map((r) => r.pctSettled)).toEqual([1, null, 3]);
    expect(out.map((r) => r.state)).toEqual(["settled", "reconstructed", "settled"]);
  });

  it("keeps an all-settled series entirely solid", () => {
    const out = splitSettledSeries([pt("a", 1), pt("b", 2)], ["settled", "settled"]);
    expect(out.map((r) => r.pctSettled)).toEqual([1, 2]);
    expect(out.map((r) => r.pctProvisional)).toEqual([null, 2]);
  });

  it("handles a series with no settled point at all", () => {
    const out = splitSettledSeries([pt("a", 1)], ["intraday"]);
    expect(out[0].pctSettled).toBeNull();
    expect(out[0].pctProvisional).toBe(1);
  });
});
