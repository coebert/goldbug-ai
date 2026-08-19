import { describe, expect, it } from "vitest";
import { AUTO_RECHECK_COOLDOWN_MS, decideAutoRecheck } from "@/lib/saxo-auto-recheck";

const base = {
  lastRunAt: null as number | null,
  now: 1_000_000,
  blockCount: 3,
  completedCategories: 1,
  busy: false,
};

describe("decideAutoRecheck", () => {
  it("runs right after a section is ticked", () => {
    expect(decideAutoRecheck(base)).toEqual({ run: true, reason: "assessment_updated" });
  });

  it("skips when nothing is blocked", () => {
    expect(decideAutoRecheck({ ...base, blockCount: 0 }).run).toBe(false);
  });

  it("skips when no section has been completed", () => {
    expect(decideAutoRecheck({ ...base, completedCategories: 0 }).reason).toBe(
      "no_completed_sections",
    );
  });

  it("skips while a run is in flight", () => {
    expect(decideAutoRecheck({ ...base, busy: true }).reason).toBe("busy");
  });

  it("respects the cooldown between automatic runs", () => {
    const lastRunAt = base.now - 1000;
    expect(decideAutoRecheck({ ...base, lastRunAt }).reason).toBe("cooldown");
    expect(
      decideAutoRecheck({ ...base, lastRunAt: base.now - AUTO_RECHECK_COOLDOWN_MS - 1 }).run,
    ).toBe(true);
  });
});
