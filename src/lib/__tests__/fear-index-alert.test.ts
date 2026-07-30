import { describe, it, expect } from "vitest";
import { evaluateFearAlert, FEAR_ALERT_THRESHOLDS } from "@/lib/fear-index-alert";

const base = {
  label: "Fear",
  reason: "VIX elevated",
  orders: [] as Array<{ symbol: string; side: string; value: number; rejected?: string | null; reason?: string | null }>,
};

describe("evaluateFearAlert", () => {
  it("fires critical when panic blocks fresh buys", () => {
    const r = evaluateFearAlert({
      ...base,
      score: 93,
      sizeMultiplier: 0,
      blockNewBuys: true,
      previousScore: 70,
      orders: [{ symbol: "AAPL", side: "buy", value: 0, rejected: "fear index 93/100 (panic) — new buys blocked" }],
    });
    expect(r.fire).toBe(true);
    expect(r.level).toBe("panic");
    expect(r.severity).toBe("critical");
    expect(r.blockedSymbols).toEqual(["AAPL"]);
    expect(r.title).toContain("new buys blocked");
  });

  it("fires a warning when elevated fear resizes buys", () => {
    const r = evaluateFearAlert({
      ...base,
      score: 72,
      sizeMultiplier: 0.6,
      blockNewBuys: false,
      previousScore: 40,
      orders: [{ symbol: "MSFT", side: "buy", value: 600, reason: "momentum; fear72×0.60" }],
    });
    expect(r.fire).toBe(true);
    expect(r.level).toBe("elevated");
    expect(r.severity).toBe("warning");
    expect(r.resizedSymbols).toEqual(["MSFT"]);
    expect(r.title).toContain("40%");
  });

  it("stays quiet below thresholds", () => {
    const r = evaluateFearAlert({ ...base, score: 45, sizeMultiplier: 1, blockNewBuys: false, previousScore: 44 });
    expect(r.fire).toBe(false);
    expect(r.level).toBeNull();
  });

  it("does not re-fire on a plateau with no sizing impact", () => {
    const r = evaluateFearAlert({ ...base, score: 65, sizeMultiplier: 0.8, blockNewBuys: false, previousScore: 66 });
    expect(r.fire).toBe(false);
  });

  it("re-fires when escalating from elevated to panic", () => {
    const r = evaluateFearAlert({ ...base, score: 91, sizeMultiplier: 0, blockNewBuys: true, previousScore: 75 });
    expect(r.fire).toBe(true);
    expect(r.crossedUp).toBe(true);
  });

  it("flags complacency at the low threshold", () => {
    const r = evaluateFearAlert({
      ...base,
      score: FEAR_ALERT_THRESHOLDS.complacency,
      sizeMultiplier: 0.9,
      blockNewBuys: false,
      previousScore: 30,
    });
    expect(r.level).toBe("complacency");
    expect(r.severity).toBe("info");
  });

  it("honours custom thresholds", () => {
    const r = evaluateFearAlert({
      ...base,
      score: 55,
      sizeMultiplier: 0.7,
      blockNewBuys: false,
      previousScore: 20,
      thresholds: { elevated: 50 },
    });
    expect(r.level).toBe("elevated");
  });
});
