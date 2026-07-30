import { describe, expect, it } from "vitest";
import {
  anchorBucketFor,
  deriveIntradayAnchors,
  SNAPSHOT_ANCHOR_HOUR_UTC,
} from "@/lib/equity-intraday-backfill";

const NOW = new Date("2026-07-30T14:30:00.000Z");

const SNAPS = [
  { snapshot_date: "2026-07-27", cash: 100, holdings_value: 900, total_value: 1000 },
  { snapshot_date: "2026-07-28", cash: 120, holdings_value: 900, total_value: 1020 },
  { snapshot_date: "2026-07-29", cash: 120, holdings_value: 880, total_value: 1000 },
];

describe("anchorBucketFor", () => {
  it("stamps a past day at the post-close anchor hour", () => {
    expect(anchorBucketFor("2026-07-27", NOW)).toBe(
      `2026-07-27T${String(SNAPSHOT_ANCHOR_HOUR_UTC).padStart(2, "0")}:00:00.000Z`,
    );
  });

  it("clamps today's snapshot to the current hour instead of the future", () => {
    expect(anchorBucketFor("2026-07-30", NOW)).toBe("2026-07-30T14:00:00.000Z");
  });

  it("rejects malformed dates", () => {
    expect(anchorBucketFor("", NOW)).toBeNull();
    expect(anchorBucketFor("not-a-date", NOW)).toBeNull();
  });
});

describe("deriveIntradayAnchors", () => {
  it("emits one hourly anchor per daily snapshot, oldest first", () => {
    const rows = deriveIntradayAnchors("p1", SNAPS, [], NOW);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.bucket_hour)).toEqual([
      "2026-07-27T21:00:00.000Z",
      "2026-07-28T21:00:00.000Z",
      "2026-07-29T21:00:00.000Z",
    ]);
    expect(rows.every((r) => r.portfolio_id === "p1")).toBe(true);
  });

  it("carries cash / holdings / total through unchanged", () => {
    const [first] = deriveIntradayAnchors("p1", SNAPS, [], NOW);
    expect(first).toMatchObject({ cash: 100, holdings_value: 900, total_value: 1000 });
  });

  it("never displaces an hour that was genuinely recorded", () => {
    const rows = deriveIntradayAnchors("p1", SNAPS, ["2026-07-28T21:00:00.000Z"], NOW);
    expect(rows.map((r) => r.bucket_hour)).toEqual([
      "2026-07-27T21:00:00.000Z",
      "2026-07-29T21:00:00.000Z",
    ]);
  });

  it("matches existing buckets even when stored with minutes or an offset", () => {
    const rows = deriveIntradayAnchors("p1", SNAPS, ["2026-07-28T21:17:04+00:00"], NOW);
    expect(rows.some((r) => r.bucket_hour.startsWith("2026-07-28"))).toBe(false);
  });

  it("is idempotent — a second pass over its own output writes nothing", () => {
    const first = deriveIntradayAnchors("p1", SNAPS, [], NOW);
    const second = deriveIntradayAnchors(
      "p1",
      SNAPS,
      first.map((r) => r.bucket_hour),
      NOW,
    );
    expect(second).toEqual([]);
  });

  it("falls back to cash-only when a legacy snapshot has no split", () => {
    const rows = deriveIntradayAnchors(
      "p1",
      [{ snapshot_date: "2026-07-27", total_value: 500 }],
      [],
      NOW,
    );
    expect(rows[0]).toMatchObject({ cash: 500, holdings_value: 0, total_value: 500 });
  });

  it("skips snapshots with unusable totals", () => {
    const rows = deriveIntradayAnchors(
      "p1",
      [
        { snapshot_date: "2026-07-27", total_value: "not-a-number" },
        { snapshot_date: "2026-07-28", total_value: 10 },
      ],
      [],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].total_value).toBe(10);
  });

  it("collapses duplicate snapshot rows for the same day", () => {
    const rows = deriveIntradayAnchors(
      "p1",
      [
        { snapshot_date: "2026-07-27", total_value: 10 },
        { snapshot_date: "2026-07-27", total_value: 11 },
      ],
      [],
      NOW,
    );
    expect(rows).toHaveLength(1);
  });

  it("never stamps a point in the future", () => {
    const rows = deriveIntradayAnchors(
      "p1",
      [...SNAPS, { snapshot_date: "2026-07-31", total_value: 1100 }],
      [],
      NOW,
    );
    for (const r of rows) expect(Date.parse(r.bucket_hour)).toBeLessThanOrEqual(NOW.getTime());
  });

  it("does not invent intra-day movement: point count equals snapshot count", () => {
    const rows = deriveIntradayAnchors("p1", SNAPS, [], NOW);
    expect(rows).toHaveLength(SNAPS.length);
    expect(rows.map((r) => r.total_value)).toEqual(SNAPS.map((s) => s.total_value));
  });
});
