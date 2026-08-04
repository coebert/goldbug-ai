import { describe, expect, it } from "vitest";
import { firstHoldingsDate, seriesStartDate } from "../portfolio-inception";

describe("firstHoldingsDate", () => {
  it("returns the earliest holding open date", () => {
    expect(
      firstHoldingsDate([
        { opened_at: "2026-07-25T10:00:00Z" },
        { opened_at: "2026-07-23T23:04:00Z" },
      ]),
    ).toBe("2026-07-23");
  });

  it("falls back to created_at and considers trades", () => {
    expect(
      firstHoldingsDate([{ created_at: "2026-08-01T00:00:00Z" }], [
        { executed_at: "2026-07-23T23:08:00Z" },
      ]),
    ).toBe("2026-07-23");
  });

  it("returns null with no rows", () => {
    expect(firstHoldingsDate([], [])).toBeNull();
    expect(firstHoldingsDate(null)).toBeNull();
  });
});

describe("seriesStartDate", () => {
  it("prefers the later of inception and first holdings", () => {
    expect(seriesStartDate("2026-07-01", "2026-07-23")).toBe("2026-07-23");
    expect(seriesStartDate("2026-07-25", "2026-07-23")).toBe("2026-07-25");
  });

  it("handles missing values", () => {
    expect(seriesStartDate(null, "2026-07-23")).toBe("2026-07-23");
    expect(seriesStartDate("2026-07-23", null)).toBe("2026-07-23");
    expect(seriesStartDate(null, null)).toBeNull();
  });
});
