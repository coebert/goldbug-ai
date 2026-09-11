import { describe, it, expect } from "vitest";
import { resolveDailyNotionalLimit, SIM_DAILY_LIMIT_PCT_OF_NAV } from "../daily-notional-limit";

describe("resolveDailyNotionalLimit", () => {
  it("uses the operator's figure verbatim for real money", () => {
    const r = resolveDailyNotionalLimit({ configuredLimit: 10_000, mode: "live_prod", navBase: 5_000_000 });
    expect(r.limit).toBe(10_000);
    expect(r.scaled).toBe(false);
  });

  it("scales a practice book to its own NAV", () => {
    const r = resolveDailyNotionalLimit({ configuredLimit: 10_000, mode: "live_sim", navBase: 1_000_000 });
    expect(r.limit).toBeCloseTo(1_000_000 * SIM_DAILY_LIMIT_PCT_OF_NAV);
    expect(r.scaled).toBe(true);
    expect(r.note).toMatch(/practice account/);
  });

  it("keeps the configured floor for a small practice book", () => {
    const r = resolveDailyNotionalLimit({ configuredLimit: 10_000, mode: "live_sim", navBase: 5_000 });
    expect(r.limit).toBe(10_000);
    expect(r.scaled).toBe(false);
  });

  it("falls back to the configured figure when NAV is unknown", () => {
    expect(resolveDailyNotionalLimit({ configuredLimit: 750, mode: "live_sim", navBase: null }).limit).toBe(750);
  });
});
