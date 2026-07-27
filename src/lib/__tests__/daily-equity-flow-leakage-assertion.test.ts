// Runtime-assertion guard: computeDailyEquityChanges must never let a
// deposit/withdrawal bleed into the daily % change, and the exported
// `assertNoFlowLeakage` helper must flag every leakage shape.

import { describe, it, expect } from "vitest";
import {
  assertNoFlowLeakage,
  computeDailyEquityChanges,
  type FlowLeakRow,
} from "../daily-equity-changes";

const clean = (over: Partial<FlowLeakRow> = {}): FlowLeakRow => ({
  date: "2026-07-02",
  prevEquity: 1000,
  equity: 1010,
  rawDelta: 10,
  netFlow: 0,
  pnl: 10,
  pct: 1,
  ...over,
});

describe("assertNoFlowLeakage", () => {
  it("accepts well-formed rows", () => {
    expect(() => assertNoFlowLeakage([clean()], "ok")).not.toThrow();
  });

  it("flags arithmetic drift when pnl + netFlow ≠ rawDelta", () => {
    // Deposit of 500 arrived; equity rose by 510 → real pnl is 10, but this
    // row incorrectly records pnl=510 (deposit leaked in).
    const bad = clean({ rawDelta: 510, netFlow: 500, pnl: 510, pct: 51 });
    expect(() => assertNoFlowLeakage([bad], "src")).toThrow(/flow leak/);
  });

  it("flags pure deposit days that produce non-zero pct", () => {
    const bad = clean({ rawDelta: 500, netFlow: 500, pnl: 0, pct: 50 });
    expect(() => assertNoFlowLeakage([bad], "src")).toThrow(/pct drift|leaked into pnl\/pct/);
  });

  it("flags pure withdrawal days that produce non-zero pct", () => {
    const bad = clean({ rawDelta: -200, netFlow: -200, pnl: 0, pct: -20 });
    expect(() => assertNoFlowLeakage([bad], "src")).toThrow(/pct drift|leaked into pnl\/pct/);
  });

  it("flags pct that was computed from rawDelta instead of pnl", () => {
    // rawDelta 60 = pnl 10 + netFlow 50; correct pct is 1%, but this row
    // reports pct=6 (i.e. rawDelta/prev), which is the classic bug.
    const bad = clean({ rawDelta: 60, netFlow: 50, pnl: 10, pct: 6 });
    expect(() => assertNoFlowLeakage([bad], "src")).toThrow(/pct drift/);
  });

  it("tolerates float noise within the default epsilon", () => {
    const row = clean({ pnl: 10 + 1e-13, pct: 1 + 1e-14 });
    expect(() => assertNoFlowLeakage([row], "ok")).not.toThrow();
  });
});

describe("computeDailyEquityChanges runtime guard", () => {
  it("returns zero-pct rows on pure-deposit days without throwing", () => {
    const rows = computeDailyEquityChanges(
      [
        { snapshot_date: "2026-07-01", total_value: 1_000 },
        { snapshot_date: "2026-07-02", total_value: 1_500 }, // +500 = deposit
        { snapshot_date: "2026-07-03", total_value: 1_530 }, // +30 real pnl
      ],
      [{ date: "2026-07-02", amount: 500 }],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].pct).toBe(0);
    expect(rows[0].pnl).toBe(0);
    expect(rows[0].netFlow).toBe(500);
    expect(rows[1].netFlow).toBe(0);
    expect(rows[1].pnl).toBeCloseTo(30, 9);
  });

  it("guard fires when a hand-crafted row leaks a deposit into pct", () => {
    // Simulate a regression by constructing a row the same shape the
    // helper would emit and passing it through the exported assertion.
    const leaked: FlowLeakRow = {
      date: "2026-07-02",
      prevEquity: 1000,
      equity: 1500,
      rawDelta: 500,
      netFlow: 500,
      pnl: 500, // BUG: should be 0
      pct: 50, // BUG: should be 0
    };
    expect(() => assertNoFlowLeakage([leaked], "regression")).toThrow();
  });
});
