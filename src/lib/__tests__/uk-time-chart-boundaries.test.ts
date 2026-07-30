import { describe, it, expect } from "vitest";
import { formatUkAxisDay, formatUkAxisHour, ukDayKey } from "@/lib/uk-time";
import { hourBucket } from "@/lib/equity-intraday.server";
import { capitalAt, addDeltas } from "@/components/equity-pct-chart";

describe("uk-time chart boundaries", () => {
  it("buckets late-evening BST instants into the London day, not the UTC day", () => {
    // 2026-07-15 23:30 London = 22:30Z same day.
    expect(ukDayKey("2026-07-15T22:30:00Z")).toBe("2026-07-15");
    // 2026-07-16 00:30 London = 2026-07-15 23:30Z — the UTC slice would say the 15th.
    expect("2026-07-15T23:30:00Z".slice(0, 10)).toBe("2026-07-15");
    expect(ukDayKey("2026-07-15T23:30:00Z")).toBe("2026-07-16");
  });

  it("passes date-only keys through unchanged", () => {
    expect(ukDayKey("2026-07-15")).toBe("2026-07-15");
  });

  it("uses GMT boundaries in winter", () => {
    expect(ukDayKey("2026-01-15T23:30:00Z")).toBe("2026-01-15");
  });

  it("labels axis and tooltip in Europe/London regardless of runtime zone", () => {
    // 13:00Z in July = 14:00 BST.
    expect(formatUkAxisHour("2026-07-15T13:00:00Z")).toContain("14:00");
    expect(formatUkAxisHour("2026-01-15T13:00:00Z")).toContain("13:00");
    expect(formatUkAxisDay("2026-07-15T23:30:00Z")).toBe("16 Jul");
  });

  it("hour buckets align with London hour boundaries", () => {
    const b = hourBucket(new Date("2026-07-15T13:42:11.500Z"));
    expect(b).toBe("2026-07-15T13:00:00.000Z");
    // London offset is a whole hour, so the bucket starts on the London hour.
    expect(formatUkAxisHour(b)).toContain("14:00");
  });

  it("credits a deposit to the London day for hourly points either side of midnight", () => {
    const deposits = [{ date: "2026-07-16", amount: 100 }];
    // 23:30 London on the 15th — deposit not yet counted.
    expect(capitalAt(1000, deposits, "2026-07-15T22:30:00Z")).toBe(1000);
    // 00:30 London on the 16th — deposit counted.
    expect(capitalAt(1000, deposits, "2026-07-15T23:30:00Z")).toBe(1100);
  });

  it("nets deposits out of the hourly delta on the correct London day", () => {
    const rows = [
      { at: "2026-07-15T22:30:00Z", value: 1000, pct: 0 },
      { at: "2026-07-15T23:30:00Z", value: 1100, pct: 0 },
    ];
    const out = addDeltas(rows, [{ date: "2026-07-16", amount: 100 }]);
    expect(out[1].deltaValue).toBeCloseTo(0, 10);
  });
});
