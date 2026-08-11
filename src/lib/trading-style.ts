// Trading style — "position" (the historical behaviour) vs "swing".
//
// Swing trading holds for days-to-weeks, not months: entries are taken on
// pullbacks/breakouts within an established trend, targets and stops are
// tighter, dead money is cut quickly by a short time stop, and the engine is
// allowed to re-enter a name much sooner after an exit.
//
// This module is PURE and client-safe. It only describes the risk-config
// overrides a style implies; `parseRiskConfig()` applies them as the *base*
// so any explicit user override still wins.

import type { RiskConfig } from "./universe.server";

export type TradingStyle = "position" | "swing";

export const TRADING_STYLES: readonly TradingStyle[] = ["position", "swing"] as const;

export function parseTradingStyle(v: unknown): TradingStyle {
  return v === "swing" ? "swing" : "position";
}

/**
 * Risk-config fields a swing profile rewrites. Everything else (asset-class
 * caps, cash floor, drawdown halts, execution params) is untouched, so the
 * user's risk dial and hard guardrails keep their meaning.
 */
export const SWING_STYLE_OVERRIDES: Partial<RiskConfig> = {
  // Exits: tighter, faster, and time-boxed.
  stop_loss_pct: 0.06,
  take_profit_pct: 0.12,
  atr_trailing_mult: 2.0,
  max_hold_days: 20,
  initial_stop_atr_mult: 2.0,
  atr_scaled_stop_enabled: true,
  atr_scaled_stop_floor_pct: 0.02,
  // Swing targets are hit in days, so aim for a nearer ATR multiple.
  take_profit_enabled: true,
  atr_take_profit_enabled: true,
  take_profit_atr_mult: 2.5,
  atr_take_profit_floor_pct: 0.04,
  atr_take_profit_cap_pct: 0.20,
  chandelier_enabled: true,
  chandelier_k_base: 2.2,
  chandelier_k_tight: 1.0,
  chandelier_tighten_after_r: 1.5,
  scale_out_enabled: true,
  scale_out_levels: [
    { r: 1, frac: 0.33 },
    { r: 2, frac: 0.33 },
  ],
  // Cut dead money quickly — a swing that hasn't worked in ~2 weeks is wrong.
  time_stop_enabled: true,
  time_stop_horizon_days: 10,
  time_stop_min_progress_r: 0.5,
  // Re-entry must be quick: the same name can set up again within days.
  reentry_lockout_enabled: true,
  reentry_atr_days_mult: 0.02,
  reentry_min_days: 2,
  reentry_max_days: 10,
  // Don't sit through earnings on a 2-week horizon.
  event_blackout_enabled: true,
  event_blackout_window_days: 5,
  // Slightly higher per-trade risk budget to compensate for the shorter hold.
  volatility_sizing: true,
  vol_target_pct: 0.018,
  // Churn control: no discretionary exit inside the first 2 sessions. Risk
  // exits (stop, trailing stop, take-profit, regime halt) always override.
  swing_min_hold_days: 2,
};

/** Minimum days a swing position must be held before a *discretionary* sell. */
export function minHoldDays(cfg: Pick<RiskConfig, "trading_style" | "swing_min_hold_days">): number {
  if (cfg.trading_style !== "swing") return 0;
  const n = Number(cfg.swing_min_hold_days ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.min(30, Math.floor(n))) : 0;
}

/** Prompt block describing the style to the decision model. */
export function tradingStylePrompt(cfg: RiskConfig): string {
  if (cfg.trading_style !== "swing") return "";
  return [
    "TRADING STYLE: SWING (holding period days to weeks — NOT months, NOT intraday).",
    `- Target holding period is 3–${cfg.max_hold_days} trading days. Positions that have not progressed within ${cfg.time_stop_horizon_days} days are time-stopped out automatically.`,
    "- Enter only where there is a defined short-horizon setup: a pullback to support/rising moving average inside an uptrend, a breakout from a tight range on expanding volume, or a mean-reversion snapback from a stretched oversold reading in a non-broken trend.",
    "- Every entry must have an implied stop within roughly 1.5–2.5×ATR and a target of at least 2× that risk. If the reward-to-risk is under 2:1, do not take the trade.",
    "- Prefer liquid names with clean, tradable ranges over slow compounders. Avoid illiquid or gapping instruments.",
    `- Do not churn: a position younger than ${minHoldDays(cfg)} session(s) must not be sold discretionarily; only risk exits (stop, trailing stop, take-profit) may close it.`,
    "- Scale out into strength: a third at 1R and a third at 2R, letting the trailing stop manage the remainder.",
    "- Size for the stop, not for conviction: a wider stop means a smaller position.",
  ].join("\n");
}
