import { describe, it, expect } from "vitest";
import {
  reconcileTailHedge,
  classifyDeferralReason,
} from "@/lib/hedging/tail-hedge-reconcile";
import type { TailHedgeDecision } from "@/lib/hedging/tail-hedge";

const dec = (over: Partial<TailHedgeDecision> = {}): TailHedgeDecision => ({
  action: "buy",
  targetPctNav: 0.05,
  targetNotional: 500,
  deltaNotional: 500,
  reason: "risk-off",
  regime: "risk_off",
  ...over,
});

describe("reconcileTailHedge", () => {
  it("records fully-applied advisory as no slippage and no deferral", () => {
    const r = reconcileTailHedge({
      decision: dec(),
      applied: { applied: true, reason: "tail_hedge buy", symbol: "GLD", qty: 3, notional: 500 },
      observedHedgeQty: 3,
      observedHedgePrice: 166.67,
      isLivePortfolio: false,
      priorTargetNotional: 0,
    });
    expect(r.slippage.kind).toBe("none");
    expect(r.slippage.notionalDiff).toBeCloseTo(0, 6);
    expect(r.deferralReason).toBeNull();
    expect(r.applied.action).toBe("buy");
    expect(r.observed.driftVsTarget).toBeCloseTo(3 * 166.67 - 500, 2);
  });

  it("flags partial fill when notional under-books cash-clip", () => {
    const r = reconcileTailHedge({
      decision: dec({ deltaNotional: 1000, targetNotional: 1000 }),
      applied: { applied: true, reason: "tail_hedge buy (cash-clipped)", symbol: "GLD", qty: 2, notional: 400 },
      observedHedgeQty: 2,
      observedHedgePrice: 200,
      isLivePortfolio: false,
      priorTargetNotional: 0,
    });
    expect(r.slippage.kind).toBe("partial");
    expect(r.slippage.notionalDiff).toBeCloseTo(600, 2);
    expect(r.slippage.pctOfAdvised).toBeCloseTo(0.6, 3);
    expect(r.deferralReason).toBeNull();
  });

  it("classifies live-portfolio deferral to broker executor", () => {
    const r = reconcileTailHedge({
      decision: dec(),
      applied: { applied: false, reason: "live portfolio: routed via broker executor", symbol: "GLD", qty: 0, notional: 0 },
      observedHedgeQty: 0,
      observedHedgePrice: 170,
      isLivePortfolio: true,
      priorTargetNotional: 0,
    });
    expect(r.slippage.kind).toBe("unfilled");
    expect(r.slippage.pctOfAdvised).toBeCloseTo(1, 3);
    expect(r.deferralReason).toBe("live_broker_deferred");
    expect(r.applied.action).toBe("none");
    expect(r.observed.driftVsTarget).toBeCloseTo(-500, 2);
  });

  it("classifies insufficient-cash unfilled buy", () => {
    const r = reconcileTailHedge({
      decision: dec(),
      applied: { applied: false, reason: "insufficient cash after buffer", symbol: "GLD", qty: 0, notional: 0 },
      observedHedgeQty: 0,
      observedHedgePrice: 170,
      isLivePortfolio: false,
      priorTargetNotional: 0,
    });
    expect(r.deferralReason).toBe("insufficient_cash");
    expect(r.slippage.kind).toBe("unfilled");
  });

  it("classifies hold advisories as no-op deferral", () => {
    const r = reconcileTailHedge({
      decision: dec({ action: "hold", deltaNotional: 0, targetNotional: 0 }),
      applied: { applied: false, reason: "hold", symbol: null, qty: 0, notional: 0 },
      observedHedgeQty: 0,
      observedHedgePrice: null,
      isLivePortfolio: false,
      priorTargetNotional: 0,
    });
    expect(r.deferralReason).toBe("hold");
    expect(r.slippage.kind).toBe("none");
    expect(r.observed.notional).toBe(0);
  });

  it("classifies no-position sell fallback", () => {
    const r = reconcileTailHedge({
      decision: dec({ action: "sell", deltaNotional: -400, targetNotional: 0 }),
      applied: { applied: false, reason: "no GLD to unwind", symbol: "GLD", qty: 0, notional: 0 },
      observedHedgeQty: 0,
      observedHedgePrice: 200,
      isLivePortfolio: false,
      priorTargetNotional: 400,
    });
    expect(classifyDeferralReason(
      { action: "sell", deltaNotional: -400, targetNotional: 0, targetPctNav: 0, reason: "" },
      { applied: false, reason: "no GLD to unwind", symbol: "GLD", qty: 0, notional: 0 },
    )).toBe("no_position_to_sell");
    expect(r.priorTargetNotional).toBe(400);
    expect(r.applied.action).toBe("none");
  });
});
