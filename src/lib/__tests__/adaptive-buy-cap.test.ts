import { describe, expect, it } from "vitest";
import { computeAdaptiveBuyCap, type BuySample } from "../adaptive-buy-cap";

const filled = (n: number): BuySample => ({ status: "filled", notionalAcctCcy: n });
const rejected = (n: number, reason = "InsufficientCash"): BuySample => ({
  status: "rejected",
  notionalAcctCcy: n,
  rejectReason: reason,
});

describe("computeAdaptiveBuyCap", () => {
  it("no history → no haircut, no per-order ceiling", () => {
    const r = computeAdaptiveBuyCap({ brokerCashAvailable: 1000, recentBuys: [] });
    expect(r.rejectRate).toBe(0);
    expect(r.aggregateMultiplier).toBe(1);
    expect(r.perOrderCap).toBeNull();
    expect(r.aggregateCap).toBe(1000);
    expect(r.learnedSource).toBe("none");
  });

  it("all fills → multiplier 1 and ceiling from largest successful notional", () => {
    const r = computeAdaptiveBuyCap({
      brokerCashAvailable: 500,
      recentBuys: [filled(20), filled(50), filled(35)],
    });
    expect(r.rejectRate).toBe(0);
    expect(r.aggregateMultiplier).toBe(1);
    expect(r.learnedSource).toBe("success");
    expect(r.learnedCeiling).toBe(50);
    // 50 * 0.95 safety * 1.0 multiplier
    expect(r.perOrderCap).toBeCloseTo(47.5, 6);
    expect(r.aggregateCap).toBe(500);
  });

  it("mixed → rejectRate haircut and ceiling from largest success", () => {
    const r = computeAdaptiveBuyCap({
      brokerCashAvailable: 200,
      recentBuys: [filled(20), filled(30), rejected(80), rejected(60)],
    });
    expect(r.samples).toEqual({ rejects: 2, successes: 2, total: 4 });
    expect(r.rejectRate).toBe(0.5);
    expect(r.aggregateMultiplier).toBe(0.5);
    expect(r.aggregateCap).toBe(100);
    expect(r.learnedSource).toBe("success");
    // 30 * 0.95 * 0.5
    expect(r.perOrderCap).toBeCloseTo(14.25, 6);
  });

  it("all rejects → floor from smallest reject × safety, and multiplier floored", () => {
    const r = computeAdaptiveBuyCap({
      brokerCashAvailable: 100,
      recentBuys: [rejected(80), rejected(36), rejected(50)],
    });
    expect(r.rejectRate).toBe(1);
    // floored at default 0.25
    expect(r.aggregateMultiplier).toBe(0.25);
    expect(r.aggregateCap).toBe(25);
    expect(r.learnedSource).toBe("reject_floor");
    expect(r.learnedCeiling).toBe(36);
    // 36 * 0.5 fallback safety * 0.25 multiplier
    expect(r.perOrderCap).toBeCloseTo(4.5, 6);
  });

  it("ignores non-InsufficientCash rejects when computing reject rate", () => {
    const r = computeAdaptiveBuyCap({
      brokerCashAvailable: 100,
      recentBuys: [
        filled(20),
        { status: "rejected", notionalAcctCcy: 50, rejectReason: "MarketClosed" },
      ],
    });
    // only the fill counts; the MarketClosed reject is dropped
    expect(r.samples).toEqual({ rejects: 0, successes: 1, total: 1 });
    expect(r.rejectRate).toBe(0);
    expect(r.aggregateMultiplier).toBe(1);
  });

  it("null brokerCashAvailable → null aggregateCap but per-order still learned", () => {
    const r = computeAdaptiveBuyCap({
      brokerCashAvailable: null,
      recentBuys: [filled(40), rejected(90)],
    });
    expect(r.aggregateCap).toBeNull();
    expect(r.perOrderCap).not.toBeNull();
  });

  it("drops zero and non-finite notionals defensively", () => {
    const r = computeAdaptiveBuyCap({
      brokerCashAvailable: 200,
      recentBuys: [
        filled(0),
        { status: "filled", notionalAcctCcy: Number.NaN },
        filled(25),
        rejected(0),
      ],
    });
    expect(r.samples).toEqual({ rejects: 0, successes: 1, total: 1 });
    expect(r.learnedCeiling).toBe(25);
  });

  it("respects minMultiplier override", () => {
    const r = computeAdaptiveBuyCap({
      brokerCashAvailable: 100,
      recentBuys: [rejected(50), rejected(60), rejected(70)],
      minMultiplier: 0.1,
    });
    expect(r.aggregateMultiplier).toBe(0.1);
    expect(r.aggregateCap).toBe(10);
  });

  it("submitted counts as a success signal for reject-rate purposes", () => {
    const r = computeAdaptiveBuyCap({
      brokerCashAvailable: 100,
      recentBuys: [
        { status: "submitted", notionalAcctCcy: 40 },
        rejected(80),
      ],
    });
    expect(r.samples).toEqual({ rejects: 1, successes: 1, total: 2 });
    expect(r.rejectRate).toBe(0.5);
    expect(r.learnedSource).toBe("success");
    expect(r.learnedCeiling).toBe(40);
  });

  it("monotonicity: adding a bigger successful fill can only raise the per-order cap", () => {
    const base = computeAdaptiveBuyCap({
      brokerCashAvailable: 1000,
      recentBuys: [filled(25)],
    });
    const bigger = computeAdaptiveBuyCap({
      brokerCashAvailable: 1000,
      recentBuys: [filled(25), filled(60)],
    });
    expect(bigger.perOrderCap!).toBeGreaterThanOrEqual(base.perOrderCap!);
  });
});
