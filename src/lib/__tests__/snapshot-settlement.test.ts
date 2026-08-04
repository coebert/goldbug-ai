import { describe, expect, it } from "vitest";
import {
  classifySnapshot,
  settledRows,
  summariseSettlement,
} from "../snapshot-settlement";

const NOW = "2026-08-04T12:47:00Z"; // 4 Aug, London

describe("classifySnapshot", () => {
  it("treats today's row as intraday regardless of writer", () => {
    expect(classifySnapshot({ snapshot_date: "2026-08-04", source: "trading_engine" }, NOW)).toBe(
      "intraday",
    );
    expect(classifySnapshot({ snapshot_date: "2026-08-04", source: "broker_sync" }, NOW)).toBe(
      "intraday",
    );
    expect(classifySnapshot({ snapshot_date: "2026-08-04", source: "backfill" }, NOW)).toBe(
      "intraday",
    );
  });

  it("treats a past observed day as a settled close", () => {
    expect(classifySnapshot({ snapshot_date: "2026-08-03", source: "trading_engine" }, NOW)).toBe(
      "settled",
    );
    expect(classifySnapshot({ snapshot_date: "2026-07-23", source: null }, NOW)).toBe("settled");
  });

  it("marks derived past rows as reconstructed", () => {
    for (const source of ["backfill", "revalue", "revalue_gap_fill", "manual"]) {
      expect(classifySnapshot({ snapshot_date: "2026-07-28", source }, NOW)).toBe("reconstructed");
    }
  });

  it("never claims a future-dated row is settled", () => {
    expect(classifySnapshot({ snapshot_date: "2026-08-05", source: "revalue" }, NOW)).toBe(
      "intraday",
    );
  });
});

describe("settledRows / summariseSettlement", () => {
  const rows = [
    { snapshot_date: "2026-07-23", source: "trading_engine" },
    { snapshot_date: "2026-07-28", source: "revalue" },
    { snapshot_date: "2026-08-03", source: "trading_engine" },
    { snapshot_date: "2026-08-04", source: "trading_engine" },
  ];

  it("keeps only observed past closes", () => {
    expect(settledRows(rows, NOW).map((r) => r.snapshot_date)).toEqual([
      "2026-07-23",
      "2026-08-03",
    ]);
  });

  it("summarises counts and anchors", () => {
    expect(summariseSettlement(rows, NOW)).toEqual({
      total: 4,
      settled: 2,
      intraday: 1,
      reconstructed: 1,
      lastSettledDate: "2026-08-03",
      provisionalDate: "2026-08-04",
      latestIsProvisional: true,
    });
  });

  it("reports a fully settled series", () => {
    const s = summariseSettlement(rows.slice(0, 3), NOW);
    expect(s.latestIsProvisional).toBe(false);
    expect(s.provisionalDate).toBeNull();
    expect(s.lastSettledDate).toBe("2026-08-03");
  });

  it("handles an empty series", () => {
    expect(summariseSettlement([], NOW)).toMatchObject({
      total: 0,
      lastSettledDate: null,
      latestIsProvisional: false,
    });
  });

  it("is order-insensitive", () => {
    const shuffled = [rows[3], rows[0], rows[2], rows[1]];
    expect(summariseSettlement(shuffled, NOW)).toEqual(summariseSettlement(rows, NOW));
  });
});
