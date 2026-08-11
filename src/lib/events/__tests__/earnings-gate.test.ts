import { describe, expect, it } from "vitest";
import { earningsGate, DEFAULT_HAIRCUT_DAYS } from "../earnings-gate";

const asOf = "2026-08-11";

describe("earnings gate", () => {
  it("never gates exits", () => {
    const r = earningsGate({ side: "sell", asOf, nextEarningsDate: "2026-08-12", confidence: "confirmed" });
    expect(r.veto).toBe(false);
    expect(r.mult).toBe(1);
  });

  it("vetoes new entries inside a confirmed blackout", () => {
    const r = earningsGate({ side: "buy", asOf, nextEarningsDate: "2026-08-12", confidence: "confirmed" });
    expect(r.veto).toBe(true);
    expect(r.daysUntil).toBe(1);
    expect(r.note).toContain("no new entry");
  });

  it("haircuts rather than vetoes when the date is only estimated", () => {
    const r = earningsGate({ side: "buy", asOf, nextEarningsDate: "2026-08-12", confidence: "estimated" });
    expect(r.veto).toBe(false);
    expect(r.mult).toBeLessThan(1);
  });

  it("haircuts entries in the wider window", () => {
    const r = earningsGate({ side: "buy", asOf, nextEarningsDate: "2026-08-15", confidence: "confirmed" });
    expect(r.veto).toBe(false);
    expect(r.mult).toBeLessThan(1);
    expect(r.daysUntil).toBe(4);
  });

  it("is inactive well before the print and after it has passed", () => {
    const far = earningsGate({
      side: "buy",
      asOf,
      nextEarningsDate: "2026-09-30",
      confidence: "confirmed",
    });
    expect(far.veto).toBe(false);
    expect(far.mult).toBe(1);

    const past = earningsGate({ side: "buy", asOf, nextEarningsDate: "2026-08-01", confidence: "confirmed" });
    expect(past.mult).toBe(1);
    expect(past.veto).toBe(false);
  });

  it("is inactive with no known date or a bad date", () => {
    expect(earningsGate({ side: "buy", asOf, nextEarningsDate: null }).mult).toBe(1);
    expect(earningsGate({ side: "buy", asOf, nextEarningsDate: "not-a-date" }).veto).toBe(false);
  });

  it("respects custom windows", () => {
    const r = earningsGate({
      side: "buy",
      asOf,
      nextEarningsDate: "2026-08-20",
      confidence: "confirmed",
      haircutDays: 12,
    });
    expect(r.mult).toBeLessThan(1);
    expect(DEFAULT_HAIRCUT_DAYS).toBe(5);
  });
});
