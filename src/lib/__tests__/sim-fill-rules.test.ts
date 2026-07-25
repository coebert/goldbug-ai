import { describe, expect, it } from "vitest";
import {
  decideSimFill,
  SIM_PRESUMED_FILL_AFTER_MS,
  SIM_LIMIT_STALE_AFTER_MS,
  SIM_STALE_UNRECOVERABLE_AFTER_MS,
} from "@/lib/sim-fill-rules";

const NOW = Date.parse("2026-07-25T12:00:00Z");
const base = {
  orderType: "market",
  status: "submitted",
  quantity: 10,
  hasBrokerOrderId: true,
  submittedAt: new Date(NOW - 3 * 60 * 1000).toISOString(),
  createdAt: null,
  now: NOW,
} as const;

describe("decideSimFill — SIM fill matching when Saxo /hist is unavailable", () => {
  it("presumes a market order filled once it has aged past the SIM wait window", () => {
    const d = decideSimFill(base);
    expect(d.kind).toBe("presumed_filled");
    if (d.kind === "presumed_filled") expect(d.ageMs).toBeGreaterThan(SIM_PRESUMED_FILL_AFTER_MS);
  });

  it("keeps a fresh market order in submitted rather than fabricating a fill", () => {
    const d = decideSimFill({ ...base, submittedAt: new Date(NOW - 30 * 1000).toISOString() });
    expect(d.kind).toBe("keep");
  });

  it("presumes a partial market order fully filled once quiet in SIM", () => {
    const d = decideSimFill({ ...base, status: "partial" });
    expect(d.kind).toBe("presumed_filled");
    if (d.kind === "presumed_filled") expect(d.reason).toMatch(/partial/i);
  });

  it("never touches terminal statuses (filled/rejected/cancelled)", () => {
    for (const status of ["filled", "rejected", "cancelled"]) {
      expect(decideSimFill({ ...base, status }).kind).toBe("keep");
    }
  });

  it("keeps orders without a broker id — they never reached Saxo", () => {
    const d = decideSimFill({ ...base, hasBrokerOrderId: false });
    expect(d.kind).toBe("keep");
    if (d.kind === "keep") expect(d.reason).toMatch(/broker id/i);
  });

  it("refuses to synthesise a fill for a zero-quantity order", () => {
    expect(decideSimFill({ ...base, quantity: 0 }).kind).toBe("keep");
  });

  it("falls back to created_at when submitted_at is missing", () => {
    const d = decideSimFill({
      ...base,
      submittedAt: null,
      createdAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    });
    expect(d.kind).toBe("presumed_filled");
  });

  it("keeps the order when both submitted_at and created_at are missing", () => {
    expect(decideSimFill({ ...base, submittedAt: null, createdAt: null }).kind).toBe("keep");
  });

  it("keeps orders with a future submitted_at (clock skew)", () => {
    const d = decideSimFill({ ...base, submittedAt: new Date(NOW + 60 * 1000).toISOString() });
    expect(d.kind).toBe("keep");
  });

  it("keeps a limit order that is younger than the 24h SIM stale window", () => {
    const d = decideSimFill({
      ...base,
      orderType: "limit",
      submittedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    });
    expect(d.kind).toBe("keep");
  });

  it("marks a limit order silent for >24h as presumed rejected, not filled", () => {
    const d = decideSimFill({
      ...base,
      orderType: "limit",
      submittedAt: new Date(NOW - SIM_LIMIT_STALE_AFTER_MS - 1000).toISOString(),
    });
    expect(d.kind).toBe("presumed_rejected");
  });

  it("presumes a very old market order rejected rather than filled", () => {
    const d = decideSimFill({
      ...base,
      submittedAt: new Date(NOW - SIM_STALE_UNRECOVERABLE_AFTER_MS - 1000).toISOString(),
    });
    expect(d.kind).toBe("presumed_rejected");
  });

  it("promotes 'error' market orders once the broker is silent past the wait window", () => {
    // The reconciler must be allowed to recover from a transient submit-time
    // error when the broker has actually accepted and executed the order.
    const d = decideSimFill({ ...base, status: "error" });
    expect(d.kind).toBe("presumed_filled");
  });

  it("treats unknown order types conservatively (never presumed filled)", () => {
    const d = decideSimFill({
      ...base,
      orderType: "stop_limit",
      submittedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    });
    expect(d.kind).toBe("keep");
  });
});
