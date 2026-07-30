import { describe, it, expect } from "vitest";
import { recordIntradayEquity, hourBucket } from "@/lib/equity-intraday.server";
import { ukDayKey, formatUkAxisTime, formatUkAxisHour, ukHour, ukZoneAbbr } from "@/lib/uk-time";
import { xAxisTicks, capitalAt, addDeltas } from "@/components/equity-pct-chart";

/**
 * End-to-end path for a single hourly equity observation:
 *
 *   run clock (instant) → recordIntradayEquity → bucket_hour row
 *     → chart x-axis label / day bucketing
 *
 * The hazard is the London offset changing twice a year: an instant recorded at
 * 13:42Z is "14:00" on the axis in July (BST, UTC+1) but "13:00" in January
 * (GMT, UTC+0). This test pins both ends of the pipeline in both regimes so a
 * timezone regression can't silently shift every hourly point by an hour.
 */

type Upserted = { table: string; values: Record<string, unknown>; onConflict?: string };

function recordingDb() {
  const writes: Upserted[] = [];
  const db = {
    from: (table: string) => ({
      upsert: async (values: unknown, options?: { onConflict?: string }) => {
        writes.push({
          table,
          values: values as Record<string, unknown>,
          onConflict: options?.onConflict,
        });
        return {};
      },
    }),
  };
  return { db, writes };
}

async function recordAt(iso: string) {
  const { db, writes } = recordingDb();
  await recordIntradayEquity(
    db,
    "portfolio-1",
    { cash: 300, holdingsValue: 10_000, totalValue: 10_300 },
    new Date(iso),
  );
  return writes[0].values.bucket_hour as string;
}

describe("hourly point → x-axis bucket, BST and GMT", () => {
  it("lands a BST afternoon observation in the 14:00 London bucket", async () => {
    // 2026-07-15 14:42 London === 13:42Z (BST, UTC+1).
    const bucket = await recordAt("2026-07-15T13:42:37.812Z");
    expect(bucket).toBe("2026-07-15T13:00:00.000Z");
    expect(ukZoneAbbr(bucket)).toBe("BST");
    expect(ukHour(bucket)).toBe(14);
    expect(formatUkAxisTime(bucket)).toBe("14:00");
    expect(formatUkAxisHour(bucket)).toContain("14:00");
    expect(ukDayKey(bucket)).toBe("2026-07-15");
  });

  it("lands the same wall-clock observation in the 14:00 bucket under GMT", async () => {
    // 2026-01-15 14:42 London === 14:42Z (GMT, UTC+0).
    const bucket = await recordAt("2026-01-15T14:42:37.812Z");
    expect(bucket).toBe("2026-01-15T14:00:00.000Z");
    expect(ukZoneAbbr(bucket)).toBe("GMT");
    expect(ukHour(bucket)).toBe(14);
    expect(formatUkAxisTime(bucket)).toBe("14:00");
    expect(ukDayKey(bucket)).toBe("2026-01-15");
  });

  it("never splits an hour: bucket start renders at :00 in both regimes", async () => {
    for (const iso of [
      "2026-07-15T00:00:00Z",
      "2026-07-15T13:59:59Z",
      "2026-01-15T00:00:00Z",
      "2026-01-15T13:59:59Z",
      // Transition days themselves.
      "2026-03-29T02:30:00Z", // clocks went forward at 01:00Z
      "2026-10-25T00:30:00Z", // clocks go back at 02:00Z
    ]) {
      const bucket = hourBucket(new Date(iso));
      expect(formatUkAxisTime(bucket).endsWith(":00")).toBe(true);
      expect(new Date(bucket).getUTCMinutes()).toBe(0);
      expect(new Date(bucket).getUTCSeconds()).toBe(0);
    }
  });

  it("attributes a late-evening BST hour to the correct London day on the axis", async () => {
    // 23:30 London on the 15th → 22:30Z; 00:30 London on the 16th → 23:30Z.
    const lateSameDay = await recordAt("2026-07-15T22:30:00Z");
    const afterMidnight = await recordAt("2026-07-15T23:30:00Z");
    expect(ukDayKey(lateSameDay)).toBe("2026-07-15");
    expect(ukDayKey(afterMidnight)).toBe("2026-07-16");

    // The capital baseline follows the same London day, so a deposit dated the
    // 16th applies to the 00:30 point and not to the 23:30 one.
    const deposits = [{ date: "2026-07-16", amount: 500 }];
    expect(capitalAt(10_000, deposits, lateSameDay)).toBe(10_000);
    expect(capitalAt(10_000, deposits, afterMidnight)).toBe(10_500);

    // …and that deposit is netted out of the hour-over-hour delta.
    const [, second] = addDeltas(
      [
        { at: lateSameDay, value: 10_000, pct: 0 },
        { at: afterMidnight, value: 10_500, pct: 0 },
      ],
      deposits,
    );
    expect(second.deltaValue).toBeCloseTo(0, 10);
  });

  it("labels a same-day hourly series with London times in both regimes", async () => {
    const summer = await Promise.all(
      ["2026-07-15T08:05:00Z", "2026-07-15T09:05:00Z", "2026-07-15T10:05:00Z"].map(recordAt),
    );
    const winter = await Promise.all(
      ["2026-01-15T08:05:00Z", "2026-01-15T09:05:00Z", "2026-01-15T10:05:00Z"].map(recordAt),
    );

    const ticks = xAxisTicks("hourly", 0.1, 3);
    expect(ticks.style).toBe("time");
    expect(summer.map(ticks.format)).toEqual(["09:00", "10:00", "11:00"]);
    expect(winter.map(ticks.format)).toEqual(["08:00", "09:00", "10:00"]);
  });

  it("keeps consecutive hours exactly one hour apart across the DST switch", async () => {
    // Clocks go back 2026-10-25 02:00 BST → 01:00 GMT. Buckets stay hourly and
    // strictly increasing, and the repeated 01:00 wall-clock hour is two
    // distinct instants rather than one overwritten bucket.
    const buckets = await Promise.all(
      ["2026-10-25T00:10:00Z", "2026-10-25T01:10:00Z", "2026-10-25T02:10:00Z"].map(recordAt),
    );
    expect(new Set(buckets).size).toBe(3);
    const ms = buckets.map((b) => new Date(b).getTime());
    expect(ms[1] - ms[0]).toBe(3_600_000);
    expect(ms[2] - ms[1]).toBe(3_600_000);
    expect(buckets.map(formatUkAxisTime)).toEqual(["01:00", "01:00", "02:00"]);
    expect(buckets.map(ukDayKey)).toEqual(["2026-10-25", "2026-10-25", "2026-10-25"]);
  });

  it("upserts on the hour bucket so repeated syncs in one hour overwrite", async () => {
    const { db, writes } = recordingDb();
    for (const iso of ["2026-07-15T13:05:00Z", "2026-07-15T13:55:00Z"]) {
      await recordIntradayEquity(
        db,
        "portfolio-1",
        { cash: 300, holdingsValue: 10_000, totalValue: 10_300 },
        new Date(iso),
      );
    }
    expect(writes).toHaveLength(2);
    expect(writes[0].values.bucket_hour).toBe(writes[1].values.bucket_hour);
    expect(writes[0].onConflict).toBe("portfolio_id,bucket_hour");
    expect(writes[0].table).toBe("equity_intraday");
  });
});
