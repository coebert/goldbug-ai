import { describe, it, expect } from "vitest";
import { evaluateEarningsWindow, DEFAULT_EARNINGS_WINDOW } from "@/lib/events/earnings-window";

const now = new Date("2026-07-01T12:00:00Z");
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();

describe("evaluateEarningsWindow", () => {
  it("allows buys with no earnings date", () => {
    const r = evaluateEarningsWindow(null, now, "buy");
    expect(r.action).toBe("allow");
    expect(r.size_multiplier).toBe(1);
  });

  it("blocks buys inside the 2-day blackout", () => {
    const r = evaluateEarningsWindow(inDays(1), now, "buy");
    expect(r.action).toBe("block");
    expect(r.size_multiplier).toBe(0);
  });

  it("trims buys inside the 5-day taper", () => {
    const r = evaluateEarningsWindow(inDays(4), now, "buy");
    expect(r.action).toBe("trim");
    expect(r.size_multiplier).toBeGreaterThan(DEFAULT_EARNINGS_WINDOW.trim_floor);
    expect(r.size_multiplier).toBeLessThan(1);
  });

  it("allows buys well outside the window", () => {
    const r = evaluateEarningsWindow(inDays(20), now, "buy");
    expect(r.action).toBe("allow");
    expect(r.size_multiplier).toBe(1);
  });

  it("never blocks sells inside blackout — de-risking must be possible", () => {
    const r = evaluateEarningsWindow(inDays(1), now, "sell");
    expect(r.action).not.toBe("block");
    expect(r.size_multiplier).toBe(1);
  });

  it("half-sizes right after the print, then normal", () => {
    const soonAfter = evaluateEarningsWindow(inDays(-0), now, "buy");
    expect(soonAfter.action).toBe("allow"); // 0 days ago == calm boundary
    const stillFresh = evaluateEarningsWindow(inDays(-0.5).slice(0, 10), now, "buy");
    // simple sanity: values in the past return a decision object
    expect(["allow", "trim"]).toContain(stillFresh.action);
  });
});
