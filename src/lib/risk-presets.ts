// Shared 1..5 risk-dial presets.
//
// These used to live inside `risk-controls-card.tsx`, but the risk-curve
// comparison needs the exact same configs on the server so a sweep reproduces
// what the dial would actually do. Keeping one table here guarantees the
// preview curves and the live portfolio settings never drift apart.

import type { CommodityGroup } from "./commodity-groups";

export type DialAssetClass = "stock" | "etf" | "crypto" | "commodity" | "fx";

/** The subset of `portfolios.risk_config` the dial owns. */
export type RiskDialConfig = {
  asset_class_limits: Partial<Record<DialAssetClass, number>>;
  per_symbol_limit_pct: number | null;
  stop_loss_pct: number;
  take_profit_pct: number;
  atr_trailing_mult: number;
  max_hold_days: number;
  volatility_sizing: boolean;
  vol_target_pct: number;
  max_daily_loss_pct: number;
  max_drawdown_halt_pct: number;
  commodity_group_limits: Partial<Record<CommodityGroup, number>>;
  commodity_min_adv_usd: number;
  commodity_max_atr_pct: number;
  fx_currency_limits?: Partial<Record<string, number>>;
  diversification_tilt?: "off" | "balanced" | "strong";
  risk_level?: number;
  /** Position-sizing multiplier applied to every buy budget (0.25–2). */
  size_multiplier?: number;
  /** How much of a wanted buy is taken in one go (0.25–1.5). */
  buy_aggressiveness?: number;
  /** How much of a wanted trim is taken in one go (0.25–1.5). */
  sell_aggressiveness?: number;
  /** "position" (months) or "swing" (days-to-weeks) trading horizon. */
  trading_style?: "position" | "swing";
  /** Swing only: minimum sessions held before a discretionary sell. */
  swing_min_hold_days?: number;
};

export const RISK_DIAL_DEFAULTS: RiskDialConfig = {
  asset_class_limits: { stock: 0.6, etf: 0.8, crypto: 0.2, commodity: 0.3, fx: 0.3 },
  per_symbol_limit_pct: null,
  stop_loss_pct: 0.1,
  take_profit_pct: 0.25,
  atr_trailing_mult: 3,
  max_hold_days: 0,
  volatility_sizing: true,
  vol_target_pct: 0.015,
  max_daily_loss_pct: 0.05,
  max_drawdown_halt_pct: 0.2,
  commodity_group_limits: { Gold: 0.2, Basket: 0.15 },
  commodity_min_adv_usd: 250_000,
  commodity_max_atr_pct: 0.06,
  fx_currency_limits: {},
};

/**
 * Dial-visible fields a swing style rewrites. The rest of the swing profile
 * (chandelier, time stop, re-entry lockout, scale-outs) is rebased serverside
 * by `parseRiskConfig` from `SWING_STYLE_OVERRIDES`.
 */
export const SWING_DIAL_OVERRIDES = {
  stop_loss_pct: 0.06,
  take_profit_pct: 0.12,
  atr_trailing_mult: 2,
  max_hold_days: 20,
  volatility_sizing: true,
  vol_target_pct: 0.018,
  swing_min_hold_days: 2,
} satisfies Partial<RiskDialConfig>;

export type RiskPreset = { name: string; blurb: string; cfg: RiskDialConfig };

/**
 * Moving the dial rewrites every field below, including the three
 * aggressiveness knobs that scale position sizing and how hard the engine
 * chases its buy/sell targets.
 */
export const RISK_PRESETS: Record<number, RiskPreset> = {
  1: {
    name: "Low risk",
    blurb: "Capital preservation. Tight stops, small positions, mostly ETFs.",
    cfg: {
      asset_class_limits: { stock: 0.3, etf: 0.9, crypto: 0.02, commodity: 0.15, fx: 0.15 },
      per_symbol_limit_pct: 0.05,
      stop_loss_pct: 0.05,
      take_profit_pct: 0.15,
      atr_trailing_mult: 2,
      max_hold_days: 60,
      volatility_sizing: true,
      vol_target_pct: 0.007,
      max_daily_loss_pct: 0.02,
      max_drawdown_halt_pct: 0.08,
      commodity_group_limits: { Gold: 0.1, Basket: 0.08 },
      commodity_min_adv_usd: 1_000_000,
      commodity_max_atr_pct: 0.04,
      size_multiplier: 0.5,
      buy_aggressiveness: 0.4,
      sell_aggressiveness: 1.2,
    },
  },
  2: {
    name: "Cautious",
    blurb: "Slow and steady growth with limited crypto/commodity exposure.",
    cfg: {
      asset_class_limits: { stock: 0.5, etf: 0.85, crypto: 0.05, commodity: 0.2, fx: 0.2 },
      per_symbol_limit_pct: 0.08,
      stop_loss_pct: 0.07,
      take_profit_pct: 0.2,
      atr_trailing_mult: 2.5,
      max_hold_days: 90,
      volatility_sizing: true,
      vol_target_pct: 0.01,
      max_daily_loss_pct: 0.03,
      max_drawdown_halt_pct: 0.12,
      commodity_group_limits: { Gold: 0.15, Basket: 0.12 },
      commodity_min_adv_usd: 500_000,
      commodity_max_atr_pct: 0.05,
      size_multiplier: 0.75,
      buy_aggressiveness: 0.6,
      sell_aggressiveness: 1.1,
    },
  },
  3: {
    name: "Balanced",
    blurb: "Default mix — moderate stops, diversified caps.",
    cfg: {
      ...RISK_DIAL_DEFAULTS,
      size_multiplier: 1,
      buy_aggressiveness: 0.8,
      sell_aggressiveness: 1,
    },
  },
  4: {
    name: "Growth",
    blurb: "Larger positions, wider stops, more crypto/commodity room.",
    cfg: {
      asset_class_limits: { stock: 0.75, etf: 0.75, crypto: 0.3, commodity: 0.4, fx: 0.4 },
      per_symbol_limit_pct: 0.2,
      stop_loss_pct: 0.15,
      take_profit_pct: 0.4,
      atr_trailing_mult: 4,
      max_hold_days: 0,
      volatility_sizing: true,
      vol_target_pct: 0.02,
      max_daily_loss_pct: 0.06,
      max_drawdown_halt_pct: 0.25,
      commodity_group_limits: { Gold: 0.3, Basket: 0.2 },
      commodity_min_adv_usd: 150_000,
      commodity_max_atr_pct: 0.08,
      size_multiplier: 1.25,
      buy_aggressiveness: 1,
      sell_aggressiveness: 0.9,
    },
  },
  5: {
    name: "High risk",
    blurb: "Aggressive concentration, wide stops, run winners hard.",
    cfg: {
      asset_class_limits: { stock: 0.9, etf: 0.6, crypto: 0.5, commodity: 0.5, fx: 0.5 },
      per_symbol_limit_pct: 0.35,
      stop_loss_pct: 0.25,
      take_profit_pct: 0.75,
      atr_trailing_mult: 5,
      max_hold_days: 0,
      volatility_sizing: false,
      vol_target_pct: 0.03,
      max_daily_loss_pct: 0.1,
      max_drawdown_halt_pct: 0.35,
      commodity_group_limits: { Gold: 0.4, Basket: 0.3 },
      commodity_min_adv_usd: 50_000,
      commodity_max_atr_pct: 0.12,
      size_multiplier: 1.5,
      buy_aggressiveness: 1.25,
      sell_aggressiveness: 0.8,
    },
  },
};

export const RISK_LEVELS = [1, 2, 3, 4, 5] as const;

export function riskPresetConfig(level: number): RiskDialConfig {
  const p = RISK_PRESETS[level] ?? RISK_PRESETS[3];
  return {
    ...p.cfg,
    asset_class_limits: { ...p.cfg.asset_class_limits },
    commodity_group_limits: { ...p.cfg.commodity_group_limits },
    risk_level: level,
  };
}

export function riskPresetName(level: number): string {
  return (RISK_PRESETS[level] ?? RISK_PRESETS[3]).name;
}
