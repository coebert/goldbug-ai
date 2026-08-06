// Explicit cash-allocation policy: regime targets, drawdown subordination,
// deployment scaling and the cash-floor relaxation rule.
import { describe, it, expect } from "vitest";
import {
  ABSOLUTE_MIN_CASH_PCT,
  MAX_DEPLOYMENT_SCALE,
  REGIME_INVESTED_BANDS,
  drawdownTaper,
  formatCashAllocationBlock,
  resolveCashAllocationPolicy,
  type CashAllocationInput,
} from "../cash-allocation-policy";

const base = (over: Partial<CashAllocationInput> = {}): CashAllocationInput => ({
  regime: "bull_quiet",
  riskLevel: "balanced",
  totalValue: 10_000,
  holdingsValue: 1_000,
  cashFloorPct: 0.1,
  portfolioDrawdownPct: 0,
  maxDrawdownHaltPct: 0.2,
  indexDrawdownPct: 0,
  targetOverridePct: null,
  ...over,
});

describe("regime bands", () => {
  it("are ordered min <= target <= max in every regime", () => {
    for (const [regime, b] of Object.entries(REGIME_INVESTED_BANDS)) {
      expect(b.min, regime).toBeLessThanOrEqual(b.target);
      expect(b.target, regime).toBeLessThanOrEqual(b.max);
      expect(b.max, regime).toBeLessThanOrEqual(1);
    }
  });

  it("are monotonically more defensive from bull to crisis", () => {
    const order = ["bull_quiet", "bull_volatile", "correction", "bear", "crisis"] as const;
    for (let i = 1; i < order.length; i++) {
      expect(REGIME_INVESTED_BANDS[order[i]].target)
        .toBeLessThan(REGIME_INVESTED_BANDS[order[i - 1]].target);
    }
  });
});

describe("drawdownTaper", () => {
  it("is neutral while less than 40% of the budget is used", () => {
    expect(drawdownTaper(0, 0.2)).toBe(1);
    expect(drawdownTaper(0.05, 0.2)).toBe(1);
    expect(drawdownTaper(0.08, 0.2)).toBe(1);
  });
  it("falls monotonically toward 0.25 at the halt level", () => {
    const a = drawdownTaper(0.12, 0.2);
    const b = drawdownTaper(0.16, 0.2);
    expect(a).toBeLessThan(1);
    expect(b).toBeLessThan(a);
    expect(drawdownTaper(0.2, 0.2)).toBeCloseTo(0.25, 6);
    expect(drawdownTaper(0.5, 0.2)).toBeCloseTo(0.25, 6);
  });
  it("is neutral with no configured budget or bad input", () => {
    expect(drawdownTaper(0.3, 0)).toBe(1);
    expect(drawdownTaper(null, 0.2)).toBe(1);
    expect(drawdownTaper(0.3, null)).toBe(1);
    expect(drawdownTaper(Number.NaN, 0.2)).toBe(1);
  });
});

describe("bull tape — does not allow the book to sit nearly flat", () => {
  it("flags a 10%-invested bull book as under-deployed and boosts buys", () => {
    const p = resolveCashAllocationPolicy(base());
    expect(p.state).toBe("underinvested");
    expect(p.targetInvestedPct).toBeCloseTo(0.9, 6);
    expect(p.deploymentScale).toBeGreaterThan(1);
    expect(p.deploymentScale).toBeLessThanOrEqual(MAX_DEPLOYMENT_SCALE);
    expect(p.deployableValue).toBeGreaterThan(0);
    expect(p.trimValue).toBe(0);
  });

  it("relaxes a cash floor that would make the target unreachable", () => {
    const p = resolveCashAllocationPolicy(base({ cashFloorPct: 0.4 }));
    expect(p.effectiveCashFloorPct).toBeCloseTo(1 - p.targetInvestedPct, 6);
    expect(p.effectiveCashFloorPct).toBeLessThan(0.4);
    expect(p.effectiveCashFloorPct).toBeGreaterThanOrEqual(ABSOLUTE_MIN_CASH_PCT);
    expect(p.note).toContain("cash floor relaxed");
  });

  it("never relaxes below the absolute minimum cash", () => {
    const p = resolveCashAllocationPolicy(
      base({ cashFloorPct: 0.5, targetOverridePct: 1 }),
    );
    expect(p.effectiveCashFloorPct).toBe(ABSOLUTE_MIN_CASH_PCT);
    expect(p.maxInvestedPct).toBeLessThanOrEqual(1 - ABSOLUTE_MIN_CASH_PCT);
  });

  it("leaves a floor alone when it is already loose enough", () => {
    const p = resolveCashAllocationPolicy(base({ cashFloorPct: 0.05 }));
    expect(p.effectiveCashFloorPct).toBe(0.05);
  });

  it("scales the boost with the size of the shortfall", () => {
    const far = resolveCashAllocationPolicy(base({ holdingsValue: 0 }));
    const near = resolveCashAllocationPolicy(base({ holdingsValue: 7_000 }));
    expect(far.deploymentScale).toBeGreaterThan(near.deploymentScale);
    expect(near.deploymentScale).toBeGreaterThanOrEqual(1);
  });
});

describe("drawdown constraint wins over the target", () => {
  it("cuts the target as the drawdown budget is consumed", () => {
    const calm = resolveCashAllocationPolicy(base());
    const hurt = resolveCashAllocationPolicy(base({ portfolioDrawdownPct: 0.16 }));
    expect(hurt.targetInvestedPct).toBeLessThan(calm.targetInvestedPct);
    expect(hurt.maxInvestedPct).toBeLessThan(calm.maxInvestedPct);
    expect(hurt.drawdownTaper).toBeLessThan(1);
  });

  it("refuses to relax the cash floor while in drawdown", () => {
    const p = resolveCashAllocationPolicy(
      base({ cashFloorPct: 0.4, portfolioDrawdownPct: 0.16 }),
    );
    expect(p.effectiveCashFloorPct).toBe(0.4);
    expect(p.maxInvestedPct).toBeLessThanOrEqual(0.6);
  });

  it("de-risks a user target too", () => {
    const ok = resolveCashAllocationPolicy(base({ targetOverridePct: 0.95 }));
    const dd = resolveCashAllocationPolicy(
      base({ targetOverridePct: 0.95, portfolioDrawdownPct: 0.18 }),
    );
    expect(ok.targetInvestedPct).toBeGreaterThan(dd.targetInvestedPct);
  });

  it("respects the user target above the regime table when calm", () => {
    const p = resolveCashAllocationPolicy(
      base({ regime: "bear", targetOverridePct: 0.5, cashFloorPct: 0 }),
    );
    expect(p.targetInvestedPct).toBeCloseTo(0.5, 6);
  });

  it("tilts down when the index is deep below its high", () => {
    const shallow = resolveCashAllocationPolicy(base({ indexDrawdownPct: -0.02 }));
    const deep = resolveCashAllocationPolicy(base({ indexDrawdownPct: -0.18 }));
    expect(deep.targetInvestedPct).toBeLessThan(shallow.targetInvestedPct);
  });
});

describe("defensive regimes cap exposure", () => {
  it("blocks new risk and asks for a trim when above the crisis ceiling", () => {
    const p = resolveCashAllocationPolicy(
      base({ regime: "crisis", holdingsValue: 8_000, cashFloorPct: 0 }),
    );
    expect(p.state).toBe("overinvested");
    expect(p.deploymentScale).toBe(0);
    expect(p.deployableValue).toBe(0);
    expect(p.trimValue).toBeGreaterThan(0);
    expect(p.trimValue).toBeCloseTo(8_000 - 10_000 * p.maxInvestedPct, 6);
  });

  it("throttles buys between target and ceiling", () => {
    const p = resolveCashAllocationPolicy(
      base({ regime: "bear", holdingsValue: 4_500, cashFloorPct: 0 }),
    );
    expect(p.state).toBe("on_target");
    expect(p.deploymentScale).toBeLessThan(1);
    expect(p.deploymentScale).toBeGreaterThanOrEqual(0.25);
  });

  it("keeps a conservative dial below an aggressive one in the same regime", () => {
    const c = resolveCashAllocationPolicy(base({ riskLevel: "conservative" }));
    const a = resolveCashAllocationPolicy(base({ riskLevel: "aggressive" }));
    expect(c.targetInvestedPct).toBeLessThan(a.targetInvestedPct);
  });
});

describe("invariants", () => {
  const regimes = Object.keys(REGIME_INVESTED_BANDS) as Array<keyof typeof REGIME_INVESTED_BANDS>;

  it("never proposes exposure above the cash-floor ceiling, in any combination", () => {
    for (const regime of regimes) {
      for (const riskLevel of ["conservative", "balanced", "aggressive"] as const) {
        for (const floor of [0, 0.05, 0.2, 0.5, 0.95]) {
          for (const dd of [0, 0.05, 0.15, 0.3]) {
            for (const held of [0, 2_500, 9_500]) {
              const p = resolveCashAllocationPolicy(
                base({ regime, riskLevel, cashFloorPct: floor, portfolioDrawdownPct: dd, holdingsValue: held }),
              );
              expect(p.maxInvestedPct).toBeLessThanOrEqual(1 - p.effectiveCashFloorPct + 1e-9);
              expect(p.effectiveCashFloorPct).toBeLessThanOrEqual(floor + 1e-9);
              expect(p.minInvestedPct).toBeLessThanOrEqual(p.targetInvestedPct + 1e-9);
              expect(p.targetInvestedPct).toBeLessThanOrEqual(p.maxInvestedPct + 1e-9);
              expect(p.deploymentScale).toBeGreaterThanOrEqual(0);
              expect(p.deploymentScale).toBeLessThanOrEqual(MAX_DEPLOYMENT_SCALE);
              expect(p.deployableValue).toBeGreaterThanOrEqual(0);
              expect(p.trimValue).toBeGreaterThanOrEqual(0);
            }
          }
        }
      }
    }
  });

  it("is a no-op for sizing when disabled but still reports the band", () => {
    const p = resolveCashAllocationPolicy(base({ enabled: false, cashFloorPct: 0.4 }));
    expect(p.enabled).toBe(false);
    expect(p.deploymentScale).toBe(1);
    expect(p.effectiveCashFloorPct).toBe(0.4);
    expect(p.targetInvestedPct).toBeGreaterThan(0);
  });

  it("handles an empty portfolio without dividing by zero", () => {
    const p = resolveCashAllocationPolicy(base({ totalValue: 0, holdingsValue: 0 }));
    expect(p.investedPct).toBe(0);
    expect(p.deployableValue).toBe(0);
    expect(Number.isFinite(p.deploymentScale)).toBe(true);
  });
});

describe("formatCashAllocationBlock", () => {
  it("tells the model to deploy when under target", () => {
    const block = formatCashAllocationBlock(resolveCashAllocationPolicy(base()), "GBP");
    expect(block).toContain("CASH-ALLOCATION POLICY");
    expect(block).toContain("underinvested");
    expect(block).toMatch(/Prefer deploying/);
  });

  it("tells the model to trim when above the ceiling", () => {
    const p = resolveCashAllocationPolicy(
      base({ regime: "crisis", holdingsValue: 9_000, cashFloorPct: 0 }),
    );
    expect(formatCashAllocationBlock(p, "GBP")).toMatch(/consider trimming/);
  });

  it("states that the target is already cut when in drawdown", () => {
    const p = resolveCashAllocationPolicy(base({ portfolioDrawdownPct: 0.18 }));
    expect(formatCashAllocationBlock(p, "GBP")).toMatch(/drawdown budget/);
  });
});
