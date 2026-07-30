import { describe, expect, it } from "vitest";
import { historyDays, spanDays } from "../equity-pct-chart";

describe("hourly chart covers all-time history", () => {
  it("requests the whole portfolio life, not a rolling month", () => {
    const now = new Date("2026-07-30T12:00:00Z");
    expect(historyDays("2026-07-29", now)).toBe(2);
    expect(historyDays("2025-07-30", now)).toBe(366);
    // Old portfolios are capped, never truncated to 30 days.
    expect(historyDays("2010-01-01", now)).toBe(3650);
  });

  it("falls back to the full cap when inception is unknown", () => {
    expect(historyDays(null)).toBe(3650);
    expect(historyDays("not-a-date")).toBe(3650);
  });

  it("measures the plotted span in days so labels can adapt", () => {
    expect(spanDays([])).toBe(0);
    expect(spanDays([{ at: "2026-07-30T09:00:00Z" }])).toBe(0);
    expect(
      spanDays([{ at: "2026-07-30T09:00:00Z" }, { at: "2026-07-30T17:00:00Z" }]),
    ).toBeCloseTo(8 / 24, 6);
    expect(
      spanDays([{ at: "2026-06-30T09:00:00Z" }, { at: "2026-07-30T09:00:00Z" }]),
    ).toBeCloseTo(30, 6);
  });
});
