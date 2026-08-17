import { describe, it, expect } from "vitest";

import { evaluateThesisBreak } from "@/lib/exits/thesis-break";
import {
  buildLossPostmortems,
  MAX_LOSS_PENALTY,
  MIN_STOP_TIGHTEN,
  type RoundTrip,
} from "@/lib/alpha/loss-postmortem";
import { roundTripsFromTrades } from "@/lib/loss-postmortem.server";

const quiet = {
  newsScore: 0.1,
  newsMomentum: 0.02,
  insiderNudge: 0,
  fundamentalsScore: 0.4,
  trendBroken: false,
  breakoutFailed: false,
};

describe("thesis-break exit", () => {
  it("never fires on a winner", () => {
    const r = evaluateThesisBreak({
      unrealisedPct: 0.05,
      effectiveStopPct: 0.08,
      evidence: { ...quiet, newsScore: -0.9, trendBroken: true, breakoutFailed: true },
    });
    expect(r.fire).toBe(false);
  });

  it("does not fire on a single deteriorating stream", () => {
    const r = evaluateThesisBreak({
      unrealisedPct: -0.05,
      effectiveStopPct: 0.08,
      evidence: { ...quiet, newsScore: -0.5 },
    });
    expect(r.fire).toBe(false);
  });

  it("fully exits a deep loser even when evidence tapes are quiet or missing", () => {
    const quietResult = evaluateThesisBreak({
      unrealisedPct: -0.076,
      effectiveStopPct: 0.1,
      evidence: quiet,
    });
    expect(quietResult.fire).toBe(true);
    expect(quietResult.sellFraction).toBe(1);
    expect(quietResult.reason).toContain("loss containment");

    const beforeBackstop = evaluateThesisBreak({
      unrealisedPct: -0.074,
      effectiveStopPct: 0.1,
      evidence: quiet,
    });
    expect(beforeBackstop.fire).toBe(false);
  });

  it("trims early when two streams agree on a shallow loss", () => {
    const r = evaluateThesisBreak({
      unrealisedPct: -0.03,
      effectiveStopPct: 0.08,
      evidence: { ...quiet, newsScore: -0.4, trendBroken: true },
    });
    expect(r.fire).toBe(true);
    expect(r.sellFraction).toBe(0.5);
    expect(r.signals).toHaveLength(2);
  });

  it("exits fully once the loss deepens or a third stream agrees", () => {
    const deep = evaluateThesisBreak({
      unrealisedPct: -0.06,
      effectiveStopPct: 0.08,
      evidence: { ...quiet, newsScore: -0.4, trendBroken: true },
    });
    expect(deep.sellFraction).toBe(1);

    const broad = evaluateThesisBreak({
      unrealisedPct: -0.03,
      effectiveStopPct: 0.08,
      evidence: { ...quiet, newsScore: -0.4, trendBroken: true, insiderNudge: -0.2 },
    });
    expect(broad.sellFraction).toBe(1);
  });

  it("fires before the hard stop distance is reached", () => {
    const r = evaluateThesisBreak({
      unrealisedPct: -0.04,
      effectiveStopPct: 0.10,
      evidence: { ...quiet, newsScore: -0.3, fundamentalsScore: -0.5 },
    });
    expect(r.fire).toBe(true);
  });
});

describe("loss post-mortem memory", () => {
  const asOf = "2026-08-16";
  const trip = (over: Partial<RoundTrip>): RoundTrip => ({
    symbol: "AAPL",
    exitDate: "2026-08-01",
    returnPct: -0.09,
    holdDays: 20,
    exitReason: "stop-loss triggered",
    ...over,
  });

  it("penalises a repeat loser and caps the penalty", () => {
    const map = buildLossPostmortems([trip({}), trip({ exitDate: "2026-07-20" }), trip({ exitDate: "2026-07-01", returnPct: -0.2 })], asOf);
    const p = map.get("AAPL")!;
    expect(p.penalty).toBeLessThan(0);
    expect(p.penalty).toBeGreaterThanOrEqual(-MAX_LOSS_PENALTY);
    expect(p.stopTightenMult).toBeGreaterThanOrEqual(MIN_STOP_TIGHTEN);
    expect(p.stopTightenMult).toBeLessThan(1);
  });

  it("applies no penalty to a net-positive record", () => {
    const map = buildLossPostmortems([trip({ returnPct: 0.12, exitReason: "take-profit" })], asOf);
    expect(map.get("AAPL")!.penalty).toBe(0);
  });

  it("decays old pain", () => {
    const recent = buildLossPostmortems([trip({ exitDate: "2026-08-10" })], asOf).get("AAPL")!;
    const stale = buildLossPostmortems([trip({ exitDate: "2025-10-01" })], asOf).get("AAPL");
    expect(recent.penalty).toBeLessThan(0);
    expect(Math.abs(stale?.penalty ?? 0)).toBeLessThan(Math.abs(recent.penalty) / 5);
  });

  it("attributes held-too-long exits and tightens the stop", () => {
    const map = buildLossPostmortems(
      [trip({ exitReason: "max-hold reached (60d)", holdDays: 60, returnPct: -0.05 })],
      asOf,
    );
    const p = map.get("AAPL")!;
    expect(p.causes[0]).toBe("held_too_long");
    expect(p.stopTightenMult).toBe(0.85);
  });
});

describe("round-trip reconstruction", () => {
  it("FIFO-matches buys against sells", () => {
    const trips = roundTripsFromTrades([
      { symbol: "MKS.L", side: "buy", price: 100, quantity: 10, trade_date: "2026-06-01", reason: null },
      { symbol: "MKS.L", side: "buy", price: 110, quantity: 10, trade_date: "2026-06-10", reason: null },
      { symbol: "MKS.L", side: "sell", price: 90, quantity: 15, trade_date: "2026-07-01", reason: "stop-loss triggered" },
    ]);
    expect(trips).toHaveLength(2);
    expect(trips[0].returnPct).toBeCloseTo(-0.1, 6);
    expect(trips[1].returnPct).toBeCloseTo((90 - 110) / 110, 6);
    expect(trips[0].holdDays).toBe(30);
  });
});
