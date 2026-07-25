import { describe, it, expect } from "vitest";
import { decideSimFill, SIM_PRESUMED_FILL_AFTER_MS, SIM_LIMIT_STALE_AFTER_MS } from "../sim-fill-rules";

// These tests lock in the market-hours interaction with decideSimFill so a
// future edit can't reintroduce the "presume fill over the weekend" bug the
// reconciler was hitting before market-hours awareness landed.

const NOW = Date.parse("2025-01-06T10:00:00Z");

const base = {
  orderType: "market",
  status: "submitted",
  submittedAt: new Date(NOW - SIM_PRESUMED_FILL_AFTER_MS - 60_000).toISOString(),
  createdAt: null,
  quantity: 10,
  hasBrokerOrderId: true,
  now: NOW,
} as const;

describe("decideSimFill · market-hours awareness", () => {
  it("does NOT presume a market order filled when the venue was closed for its entire life", () => {
    const d = decideSimFill({
      ...base,
      marketHadOpenPeriod: false,
      venueLabel: "LSE",
      nextOpenIso: "2025-01-06T08:00:00.000Z",
    });
    expect(d.kind).toBe("keep");
    if (d.kind === "keep") {
      expect(d.reason).toMatch(/LSE market closed since submission/);
      expect(d.reason).toMatch(/next open/);
    }
  });

  it("still presumes a market order filled when the venue had an open session", () => {
    const d = decideSimFill({ ...base, marketHadOpenPeriod: true, venueLabel: "LSE" });
    expect(d.kind).toBe("presumed_filled");
  });

  it("defaults to the original behaviour (open) when marketHadOpenPeriod is omitted", () => {
    const d = decideSimFill(base);
    expect(d.kind).toBe("presumed_filled");
  });

  it("defers the 24h stale-limit rejection when the venue was closed throughout", () => {
    const d = decideSimFill({
      ...base,
      orderType: "limit",
      submittedAt: new Date(NOW - SIM_LIMIT_STALE_AFTER_MS - 3_600_000).toISOString(),
      marketHadOpenPeriod: false,
      venueLabel: "LSE",
      nextOpenIso: "2025-01-06T08:00:00.000Z",
    });
    expect(d.kind).toBe("keep");
    if (d.kind === "keep") {
      expect(d.reason).toMatch(/deferring stale-reject/);
    }
  });

  it("still rejects a 24h-stale limit when the venue had time to trade", () => {
    const d = decideSimFill({
      ...base,
      orderType: "limit",
      submittedAt: new Date(NOW - SIM_LIMIT_STALE_AFTER_MS - 3_600_000).toISOString(),
      marketHadOpenPeriod: true,
      venueLabel: "LSE",
    });
    expect(d.kind).toBe("presumed_rejected");
  });
});
