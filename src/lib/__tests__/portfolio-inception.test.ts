import { describe, expect, it } from "vitest";
import { clipToInception, portfolioInceptionDate } from "../portfolio-inception";

describe("portfolioInceptionDate", () => {
  it("uses the later of creation and live activation", () => {
    expect(
      portfolioInceptionDate({
        created_at: "2026-07-24T10:30:42Z",
        live_activated_at: "2026-07-27T09:00:00Z",
      }),
    ).toBe("2026-07-27");
    expect(
      portfolioInceptionDate({
        created_at: "2026-07-24T10:30:42Z",
        live_activated_at: "2026-07-24T10:30:42Z",
      }),
    ).toBe("2026-07-24");
  });

  it("falls back to whichever field is present", () => {
    expect(portfolioInceptionDate({ created_at: "2026-07-23T00:00:00Z" })).toBe("2026-07-23");
    expect(portfolioInceptionDate({ live_activated_at: "2026-07-23T00:00:00Z" })).toBe("2026-07-23");
  });

  it("returns null when unknown", () => {
    expect(portfolioInceptionDate(null)).toBeNull();
    expect(portfolioInceptionDate({})).toBeNull();
    expect(portfolioInceptionDate({ created_at: "nonsense" })).toBeNull();
  });
});

describe("clipToInception", () => {
  const rows = [
    { snapshot_date: "2026-06-26", total_value: 124.27 },
    { snapshot_date: "2026-07-23", total_value: 299.74 },
    { snapshot_date: "2026-07-24", total_value: 300.46 },
    { snapshot_date: "2026-07-30", total_value: 10311.09 },
  ];

  it("drops pre-inception snapshots and keeps the inception day", () => {
    const out = clipToInception(rows, "2026-07-24", (r) => r.snapshot_date);
    expect(out.map((r) => r.snapshot_date)).toEqual(["2026-07-24", "2026-07-30"]);
  });

  it("keeps everything when inception is unknown", () => {
    expect(clipToInception(rows, null, (r) => r.snapshot_date)).toHaveLength(4);
  });

  it("handles hourly timestamps", () => {
    const hourly = [{ at: "2026-07-23T21:00:00Z" }, { at: "2026-07-24T09:00:00Z" }];
    expect(clipToInception(hourly, "2026-07-24", (r) => r.at)).toEqual([
      { at: "2026-07-24T09:00:00Z" },
    ]);
  });
});
