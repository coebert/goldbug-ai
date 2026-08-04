import { describe, expect, it } from "vitest";
import {
  checkValuationConsistency,
  findSnapshotGaps,
  type ConsistencySnapshot,
} from "../valuation-consistency";

const day = (date: string, total: number): ConsistencySnapshot => ({
  snapshot_date: date,
  total_value: total,
  holdings_value: total * 0.8,
  cash: total * 0.2,
});

describe("findSnapshotGaps", () => {
  it("stays quiet on a continuous weekday series", () => {
    const gaps = findSnapshotGaps({
      snapshots: [
        { date: "2026-07-20", total: 100 },
        { date: "2026-07-21", total: 101 },
        { date: "2026-07-22", total: 102 },
      ],
    });
    expect(gaps).toEqual([]);
  });

  it("ignores weekends", () => {
    // Fri 2026-07-24 → Mon 2026-07-27: no weekdays missing.
    const gaps = findSnapshotGaps({
      snapshots: [
        { date: "2026-07-24", total: 100 },
        { date: "2026-07-27", total: 101 },
      ],
    });
    expect(gaps).toEqual([]);
  });

  it("ignores a single missing weekday (venue holiday)", () => {
    const gaps = findSnapshotGaps({
      snapshots: [
        { date: "2026-07-20", total: 100 },
        { date: "2026-07-22", total: 101 },
      ],
    });
    expect(gaps).toEqual([]);
  });

  it("flags a multi-day interior hole even when values barely move", () => {
    const gaps = findSnapshotGaps({
      snapshots: [
        { date: "2026-07-22", total: 10_000 },
        { date: "2026-07-31", total: 10_050 },
      ],
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      from: "2026-07-22",
      to: "2026-07-31",
      kind: "interior",
      missing_days: 8,
      missing_weekdays: 6,
      value_from: 10_000,
      value_to: 10_050,
    });
    expect(gaps[0]!.explanation).toContain("straight line");
  });

  it("flags a stale tail against today", () => {
    const gaps = findSnapshotGaps({
      snapshots: [{ date: "2026-07-27", total: 500 }],
      today: "2026-08-04",
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.kind).toBe("trailing");
    expect(gaps[0]!.value_to).toBeNull();
    expect(gaps[0]!.missing_weekdays).toBe(6);
  });

  it("honours a custom threshold and sorts longest first", () => {
    const gaps = findSnapshotGaps({
      snapshots: [
        { date: "2026-07-01", total: 10 },
        { date: "2026-07-06", total: 11 },
        { date: "2026-07-20", total: 12 },
      ],
      minWeekdays: 3,
    });
    expect(gaps.map((g) => g.from)).toEqual(["2026-07-06"]);
  });
});

describe("checkValuationConsistency continuity", () => {
  it("reports gaps alongside jumps and with no jumps at all", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [day("2026-07-22", 10_000), day("2026-07-31", 10_100)],
      today: "2026-08-04",
    });
    expect(report.jumps).toEqual([]);
    expect(report.gapThreshold).toBe(2);
    expect(report.gaps.map((g) => g.kind)).toEqual(["interior", "trailing"]);
  });

  it("keeps gaps empty for a clean, current series", () => {
    const report = checkValuationConsistency({
      portfolioId: "p1",
      snapshots: [
        day("2026-08-03", 100),
        day("2026-08-04", 101),
      ],
      today: "2026-08-04",
    });
    expect(report.gaps).toEqual([]);
  });
});
