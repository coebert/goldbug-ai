import { describe, expect, it } from "vitest";

import { buildTradeLevels, stopDistancePct, targetDistancePct } from "../trade-levels";

const CFG = {
  stop_loss_pct: 0.1,
  take_profit_pct: 0.25,
  take_profit_enabled: true,
  atr_trailing_mult: 3,
  atr_scaled_stop_enabled: true,
  initial_stop_atr_mult: 2,
  atr_scaled_stop_floor_pct: 0.02,
  atr_take_profit_enabled: true,
  take_profit_atr_mult: 4,
  atr_take_profit_floor_pct: 0.06,
  atr_take_profit_cap_pct: 0.4,
  max_hold_days: 30,
};

describe("stop / target distances", () => {
  it("uses the ATR-scaled stop but never wider than the hard stop", () => {
    expect(stopDistancePct(CFG, 0.03).pct).toBeCloseTo(0.06, 10);
    expect(stopDistancePct(CFG, 0.2).pct).toBeCloseTo(0.1, 10); // capped by hard stop
    expect(stopDistancePct(CFG, 0.001).pct).toBeCloseTo(0.02, 10); // floor
  });

  it("falls back to the flat stop when ATR scaling is off", () => {
    expect(stopDistancePct({ ...CFG, atr_scaled_stop_enabled: false }, 0.05).pct).toBeCloseTo(0.1, 10);
  });

  it("clamps the ATR target and honours the disable switch", () => {
    expect(targetDistancePct(CFG, 0.04)?.pct).toBeCloseTo(0.16, 10);
    expect(targetDistancePct(CFG, 0.5)?.pct).toBeCloseTo(0.4, 10);
    expect(targetDistancePct({ ...CFG, take_profit_enabled: false }, 0.04)).toBeNull();
  });
});

describe("buildTradeLevels", () => {
  it("returns null without any usable price", () => {
    expect(buildTradeLevels({ action: "buy", config: CFG })).toBeNull();
  });

  it("derives trigger, limit, stop, target and trailing for a buy", () => {
    const plan = buildTradeLevels({
      action: "buy",
      decisionPrice: 100,
      atrPct: 0.03,
      currency: "GBP",
      config: CFG,
    })!;
    expect(plan.side).toBe("buy");
    expect(plan.referencePrice).toBe(100);
    const by = Object.fromEntries(plan.levels.map((l) => [l.key, l]));
    expect(by["trigger"]!.price).toBe(100);
    expect(by["limit"]!.price).toBeGreaterThan(100); // marketable limit pays up
    expect(by["stop"]!.price).toBeCloseTo(94, 6); // 2 x 3% ATR
    expect(by["target"]!.price).toBeCloseTo(112, 6); // 4 x 3% ATR
    expect(by["trailing"]!.price).toBeCloseTo(91, 6); // 3 x 3% ATR
    expect(plan.riskReward).toBeCloseTo(2, 6);
    expect(plan.maxHoldDays).toBe(30);
    expect(plan.atrSource).toBe("measured");
  });

  it("anchors stop and target on average cost for a sell and prices the limit below", () => {
    const plan = buildTradeLevels({
      action: "sell",
      decisionPrice: 90,
      avgCost: 100,
      atrPct: 0.03,
      config: CFG,
    })!;
    const by = Object.fromEntries(plan.levels.map((l) => [l.key, l]));
    expect(by["limit"]!.price).toBeLessThan(90);
    expect(by["cost_basis"]!.price).toBe(100);
    expect(by["stop"]!.price).toBeCloseTo(94, 6);
    expect(by["target"]!.price).toBeCloseTo(112, 6);
  });

  it("falls back to an assumed ATR and flags it", () => {
    const plan = buildTradeLevels({ action: "hold", featurePrice: 50, config: CFG })!;
    expect(plan.atrSource).toBe("assumed");
    expect(plan.atrPct).toBeNull();
    expect(plan.notes.join(" ")).toMatch(/default volatility/i);
    // A hold has no order, so no limit level.
    expect(plan.levels.some((l) => l.key === "limit")).toBe(false);
  });

  it("notes a disabled take-profit leg and reports no reward", () => {
    const plan = buildTradeLevels({
      action: "buy",
      decisionPrice: 100,
      atrPct: 0.03,
      config: { ...CFG, take_profit_enabled: false },
    })!;
    expect(plan.rewardPct).toBeNull();
    expect(plan.riskReward).toBeNull();
    expect(plan.notes.join(" ")).toMatch(/take-profit leg is switched off/i);
  });
});
