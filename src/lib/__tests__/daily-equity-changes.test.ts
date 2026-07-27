// Test coverage for computeDailyEquityChanges — the daily % change
// helper must exclude external cash flows (deposits/withdrawals)
// exactly the same way computeModeSummary does.

import { describe, expect, it } from "vitest";
import { computeDailyEquityChanges } from "../daily-equity-changes";

describe("computeDailyEquityChanges", () => {
  it("returns [] when fewer than two snapshots", () => {
    expect(computeDailyEquityChanges([])).toEqual([]);
    expect(
      computeDailyEquityChanges([{ snapshot_date: "2026-07-27", total_value: 300 }]),
    ).toEqual([]);
  });

  it("computes raw daily pct with no deposits", () => {
    const out = computeDailyEquityChanges([
      { snapshot_date: "2026-07-26", total_value: 300 },
      { snapshot_date: "2026-07-27", total_value: 315 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].pnl).toBe(15);
    expect(out[0].pct).toBeCloseTo(5, 5);
  });

  it("nets a same-day deposit out of the daily pct", () => {
    const out = computeDailyEquityChanges(
      [
        { snapshot_date: "2026-07-26", total_value: 300 },
        { snapshot_date: "2026-07-27", total_value: 520 },
      ],
      [{ date: "2026-07-27", amount: 200 }],
    );
    expect(out[0].netFlow).toBe(200);
    expect(out[0].pnl).toBe(20);
    expect(out[0].pct).toBeCloseTo((20 / 300) * 100, 5);
  });

  it("ignores a deposit dated on the prev snapshot (already baked in)", () => {
    const out = computeDailyEquityChanges(
      [
        { snapshot_date: "2026-07-26", total_value: 500 },
        { snapshot_date: "2026-07-27", total_value: 515 },
      ],
      [{ date: "2026-07-26", amount: 200 }],
    );
    expect(out[0].pnl).toBe(15);
  });

  it("nets withdrawals symmetrically", () => {
    const out = computeDailyEquityChanges(
      [
        { snapshot_date: "2026-07-26", total_value: 500 },
        { snapshot_date: "2026-07-27", total_value: 480 },
      ],
      [{ date: "2026-07-27", amount: -30 }],
    );
    expect(out[0].pnl).toBe(10);
  });

  it("emits one row per consecutive pair over a longer series", () => {
    const out = computeDailyEquityChanges([
      { snapshot_date: "2026-07-24", total_value: 100 },
      { snapshot_date: "2026-07-25", total_value: 110 },
      { snapshot_date: "2026-07-26", total_value: 105 },
      { snapshot_date: "2026-07-27", total_value: 120 },
    ]);
    expect(out.map((r) => r.date)).toEqual([
      "2026-07-25",
      "2026-07-26",
      "2026-07-27",
    ]);
    expect(out.map((r) => Math.round(r.pct * 100) / 100)).toEqual([
      10,
      -4.55,
      14.29,
    ]);
  });
});
