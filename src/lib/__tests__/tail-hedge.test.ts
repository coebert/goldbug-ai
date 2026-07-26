import { describe, it, expect } from "vitest";
import { computeTailHedge, DEFAULT_TAIL_HEDGE_CONFIG } from "../hedging/tail-hedge";

describe("computeTailHedge", () => {
  const nav = 100_000;

  it("returns hedge-off when NAV is 0 and sells any existing hedge", () => {
    const d = computeTailHedge({ nav: 0, cape: 30, regime: "risk_on", currentHedgeNotional: 1_000 });
    expect(d.targetNotional).toBe(0);
    expect(d.action).toBe("sell");
    expect(d.deltaNotional).toBe(-1_000);
  });

  it("sizes at baseline when CAPE at floor and regime is risk_on", () => {
    const d = computeTailHedge({
      nav, cape: DEFAULT_TAIL_HEDGE_CONFIG.capeFloor, regime: "risk_on", currentHedgeNotional: 0,
    });
    expect(d.targetPctNav).toBeCloseTo(DEFAULT_TAIL_HEDGE_CONFIG.baselinePctNav, 6);
    expect(d.targetNotional).toBeCloseTo(nav * DEFAULT_TAIL_HEDGE_CONFIG.baselinePctNav, 4);
    expect(d.action).toBe("buy");
  });

  it("sizes to max at/above CAPE cap in risk_on", () => {
    const d = computeTailHedge({
      nav, cape: DEFAULT_TAIL_HEDGE_CONFIG.capeCap + 5, regime: "risk_on", currentHedgeNotional: 0,
    });
    expect(d.targetPctNav).toBeCloseTo(DEFAULT_TAIL_HEDGE_CONFIG.maxPctNav, 6);
  });

  it("cuts hedge sharply in risk_off and high_vol", () => {
    const off = computeTailHedge({ nav, cape: 35, regime: "risk_off", currentHedgeNotional: 0 });
    const hv = computeTailHedge({ nav, cape: 35, regime: "high_vol", currentHedgeNotional: 0 });
    const on = computeTailHedge({ nav, cape: 35, regime: "risk_on", currentHedgeNotional: 0 });
    expect(off.targetPctNav).toBeLessThan(on.targetPctNav);
    expect(hv.targetPctNav).toBeLessThan(on.targetPctNav);
    // 0.25x multiplier of the CAPE-scaled baseline
    expect(off.targetPctNav).toBeCloseTo(on.targetPctNav * 0.25, 6);
  });

  it("holds when delta is within rebalance threshold", () => {
    const target = 0.01 * nav; // baseline
    const d = computeTailHedge({
      nav, cape: DEFAULT_TAIL_HEDGE_CONFIG.capeFloor, regime: "risk_on",
      currentHedgeNotional: target + 10, // tiny drift
    });
    expect(d.action).toBe("hold");
    expect(d.deltaNotional).toBe(0);
  });

  it("emits sell when current exceeds target beyond threshold", () => {
    const d = computeTailHedge({
      nav, cape: DEFAULT_TAIL_HEDGE_CONFIG.capeFloor, regime: "risk_off",
      currentHedgeNotional: 2_000, // way over the ~250 target
    });
    expect(d.action).toBe("sell");
    expect(d.deltaNotional).toBeLessThan(0);
  });

  it("never exceeds max NAV cap even with extreme CAPE and low_vol boost", () => {
    const d = computeTailHedge({ nav, cape: 100, regime: "low_vol", currentHedgeNotional: 0 });
    expect(d.targetPctNav).toBeLessThanOrEqual(DEFAULT_TAIL_HEDGE_CONFIG.maxPctNav + 1e-9);
  });
});
