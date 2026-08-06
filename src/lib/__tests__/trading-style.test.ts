// Swing trading style — config rebasing and the discretionary-sell churn guard.
import { describe, it, expect } from "vitest";
import { parseRiskConfig, DEFAULT_RISK_CONFIG } from "@/lib/universe.server";
import { minHoldDays, tradingStylePrompt, SWING_STYLE_OVERRIDES } from "@/lib/trading-style";

describe("trading style", () => {
  it("defaults to position style with unchanged legacy config", () => {
    const cfg = parseRiskConfig({});
    expect(cfg.trading_style).toBe("position");
    expect(cfg.max_hold_days).toBe(DEFAULT_RISK_CONFIG.max_hold_days);
    expect(cfg.time_stop_horizon_days).toBe(DEFAULT_RISK_CONFIG.time_stop_horizon_days);
    expect(minHoldDays(cfg)).toBe(0);
    expect(tradingStylePrompt(cfg)).toBe("");
  });

  it("rebases exit/holding defaults for swing", () => {
    const cfg = parseRiskConfig({ trading_style: "swing" });
    expect(cfg.trading_style).toBe("swing");
    expect(cfg.max_hold_days).toBe(SWING_STYLE_OVERRIDES.max_hold_days);
    expect(cfg.time_stop_horizon_days).toBe(10);
    expect(cfg.stop_loss_pct).toBeLessThan(DEFAULT_RISK_CONFIG.stop_loss_pct);
    expect(cfg.take_profit_pct).toBeLessThan(DEFAULT_RISK_CONFIG.take_profit_pct);
    expect(cfg.reentry_min_days).toBeLessThan(DEFAULT_RISK_CONFIG.reentry_min_days);
    expect(minHoldDays(cfg)).toBe(2);
    expect(tradingStylePrompt(cfg)).toContain("SWING");
  });

  it("keeps hard guardrails (caps, cash floor, drawdown halt) untouched", () => {
    const cfg = parseRiskConfig({ trading_style: "swing" });
    expect(cfg.asset_class_limits).toEqual(DEFAULT_RISK_CONFIG.asset_class_limits);
    expect(cfg.cash_floor_pct).toBe(DEFAULT_RISK_CONFIG.cash_floor_pct);
    expect(cfg.max_drawdown_halt_pct).toBe(DEFAULT_RISK_CONFIG.max_drawdown_halt_pct);
    expect(cfg.max_daily_loss_pct).toBe(DEFAULT_RISK_CONFIG.max_daily_loss_pct);
  });

  it("lets explicit user overrides win over the style base", () => {
    const cfg = parseRiskConfig({
      trading_style: "swing",
      stop_loss_pct: 0.09,
      max_hold_days: 45,
      swing_min_hold_days: 5,
    });
    expect(cfg.stop_loss_pct).toBeCloseTo(0.09);
    expect(cfg.max_hold_days).toBe(45);
    expect(minHoldDays(cfg)).toBe(5);
  });

  it("clamps the min-hold guard and ignores it outside swing", () => {
    expect(minHoldDays(parseRiskConfig({ trading_style: "swing", swing_min_hold_days: 999 }))).toBe(30);
    expect(minHoldDays(parseRiskConfig({ trading_style: "swing", swing_min_hold_days: -3 }))).toBe(0);
    expect(minHoldDays(parseRiskConfig({ swing_min_hold_days: 7 }))).toBe(0);
  });
});
