import { describe, expect, it } from "vitest";
import {
  coerceFeeSyncStatus,
  summariseFeeSync,
  type FeeSyncRow,
} from "@/lib/fee-sync-status";

describe("coerceFeeSyncStatus", () => {
  it("classifies legacy rows from fee_source when no status was stored", () => {
    expect(coerceFeeSyncStatus({ feeSource: "broker" })).toBe("invoiced");
    expect(coerceFeeSyncStatus({ feeSource: "model", fee: 3 })).toBe("pending");
    expect(coerceFeeSyncStatus({ fee: 4 })).toBe("invoiced");
    expect(coerceFeeSyncStatus({})).toBe("pending");
  });

  it("ignores a status value the column would never hold", () => {
    expect(coerceFeeSyncStatus({ feeSyncStatus: "nonsense", feeSource: "broker" })).toBe("invoiced");
  });
});

describe("summariseFeeSync", () => {
  const rows: FeeSyncRow[] = [
    { feeSyncStatus: "invoiced", feeSyncedAt: "2026-08-11T09:00:00.000Z", feeSyncAttemptedAt: "2026-08-11T09:00:00.000Z" },
    { feeSyncStatus: "invoiced", feeSyncedAt: "2026-08-11T13:00:00.000Z", feeSyncAttemptedAt: "2026-08-11T13:00:00.000Z" },
    {
      feeSyncStatus: "pending",
      feeSyncReason: "broker has not published charges for this trade yet",
      feeSyncAttemptedAt: "2026-08-11T14:00:00.000Z",
    },
    {
      feeSyncStatus: "unmatched",
      feeSyncReason: "no charge in the broker report matched this trade",
      feeSyncAttemptedAt: "2026-08-11T14:00:00.000Z",
    },
  ];

  it("reports coverage over the tape it was given", () => {
    const s = summariseFeeSync(rows);
    expect(s.total).toBe(4);
    expect(s.invoiced).toBe(2);
    expect(s.coverage).toBe(0.5);
  });

  it("keeps the last successful sync distinct from the last attempt", () => {
    const s = summariseFeeSync(rows);
    expect(s.lastSyncedAt).toBe("2026-08-11T13:00:00.000Z");
    expect(s.lastAttemptAt).toBe("2026-08-11T14:00:00.000Z");
  });

  it("surfaces one reason per bucket and drops empty buckets", () => {
    const s = summariseFeeSync(rows);
    expect(s.buckets.map((b) => b.status)).toEqual(["invoiced", "pending", "unmatched"]);
    expect(s.buckets.find((b) => b.status === "unmatched")?.reason).toMatch(/no charge/);
    expect(s.buckets.find((b) => b.status === "invoiced")?.reason).toBeNull();
  });

  it("picks the most common reason when a bucket has several", () => {
    const s = summariseFeeSync([
      { feeSyncStatus: "unmatched", feeSyncReason: "quantity mismatch" },
      { feeSyncStatus: "unmatched", feeSyncReason: "no charge in the broker report matched this trade" },
      { feeSyncStatus: "unmatched", feeSyncReason: "no charge in the broker report matched this trade" },
    ]);
    expect(s.buckets[0]?.reason).toBe("no charge in the broker report matched this trade");
  });

  it("never reports a sync time from a fill that is not invoiced", () => {
    const s = summariseFeeSync([
      { feeSyncStatus: "unmatched", feeSyncedAt: "2026-08-11T09:00:00.000Z" },
    ]);
    expect(s.lastSyncedAt).toBeNull();
  });

  it("is empty and safe on an empty tape", () => {
    const s = summariseFeeSync([]);
    expect(s).toMatchObject({ total: 0, invoiced: 0, coverage: 0, buckets: [], lastSyncedAt: null });
  });

  it("classifies a whole unsupported account in one bucket", () => {
    const s = summariseFeeSync(
      Array.from({ length: 12 }, () => ({
        feeSyncStatus: "unsupported",
        feeSyncReason: "broker publishes no cost report for this account",
      })),
    );
    expect(s.buckets).toHaveLength(1);
    expect(s.buckets[0]).toMatchObject({ status: "unsupported", count: 12 });
    expect(s.coverage).toBe(0);
  });
});
