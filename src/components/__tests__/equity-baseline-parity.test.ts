import { describe, it, expect } from "vitest";
import { capitalAt } from "@/components/equity-pct-chart";
import { ukDayKey } from "@/lib/uk-time";

/**
 * The "zero" line on the equity chart is the invested-capital baseline, and it
 * must be identical whichever resolution is being viewed. Daily rows carry a
 * `YYYY-MM-DD` date; hourly rows carry a full ISO timestamp. If those two ever
 * resolved deposits differently, the same moment in time would print a
 * different percentage in the Daily and Hourly views, and the zero line would
 * sit at a different equity value in each.
 */
describe("equity baseline parity: Daily vs Hourly", () => {
  const base = 10_300;
  const deposits = [
    { date: "2026-07-27", amount: 10_000 },
    { date: "2026-07-29T09:30:00.000Z", amount: 250 },
  ];

  it("resolves the same capital for every hour of a day as for that day", () => {
    // Hours are matched to the *Europe/London* calendar day (the market clock),
    // so 23:00Z in BST belongs to the next London day — compare each hourly
    // instant against the daily value for the day it actually falls in.
    for (const day of ["2026-07-26", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30"]) {
      for (const hh of ["00", "07", "12", "16", "23"]) {
        const at = `${day}T${hh}:00:00.000Z`;
        expect(capitalAt(base, deposits, at)).toBe(capitalAt(base, deposits, ukDayKey(at)));
      }
    }
  });

  it("puts zero at the starting investment before any deposit", () => {
    const capital = capitalAt(base, deposits, "2026-07-26T14:00:00.000Z");
    expect(capital).toBe(10_300);
    // Equity exactly equal to the starting pot must read as 0%.
    expect(((10_300 - capital) / capital) * 100).toBe(0);
  });

  it("gives the same pct for a backfilled last hour as for that day's close", () => {
    // The backfill guarantees the final hour of each day equals the daily close.
    const dailyClose = 10_310.46;
    const day = "2026-07-30";
    const dailyPct =
      ((dailyClose - capitalAt(base, deposits, day)) / capitalAt(base, deposits, day)) * 100;
    const hourlyCapital = capitalAt(base, deposits, `${day}T16:00:00.000Z`);
    const hourlyPct = ((dailyClose - hourlyCapital) / hourlyCapital) * 100;
    expect(hourlyPct).toBe(dailyPct);
  });

  it("moves the zero line by the deposit on the deposit day, in both views", () => {
    expect(capitalAt(base, deposits, "2026-07-26")).toBe(10_300);
    expect(capitalAt(base, deposits, "2026-07-27")).toBe(20_300);
    expect(capitalAt(base, deposits, "2026-07-27T00:00:00.000Z")).toBe(20_300);
    expect(capitalAt(base, deposits, "2026-07-29T23:00:00.000Z")).toBe(20_550);
  });
});
