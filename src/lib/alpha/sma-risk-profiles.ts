// Per-risk-profile SMA crossover rule configuration.
//
// The backtest (Aug 2026, `price_cache` daily closes) showed the SMA20/50
// cross is the profit driver while the SMA50/200 regime filter is the
// drawdown control. The three risk profiles therefore differ mainly in how
// much confirmation they demand before acting and how hard the death-cross
// regime bites:
//
//   conservative — wide separation bands, two-bar confirmation, exposure
//                  falls off fast as the death spread deepens and the buy is
//                  dropped early; exits fully on a fresh death cross.
//   balanced     — the tuned defaults.
//   aggressive   — narrow bands, stale crosses still tradeable, larger
//                  upsizing, and a death regime that mostly just sizes down.
//
// None of them gate on the regime as a boolean: every profile scales buy
// size with SMA200 regime strength and only skips the trade once that
// scaling takes the ticket below `minTradeableSizeMult`.

import { DEFAULT_SMA_CROSS_RULES, type SmaCrossRuleConfig } from "./sma-cross-rules";

export type SmaRiskLevel = "conservative" | "balanced" | "aggressive";

const OVERRIDES: Record<SmaRiskLevel, Partial<SmaCrossRuleConfig>> = {
  conservative: {
    fastSeparationPct: 0.004,
    regimeSeparationPct: 0.008,
    confirmBars: 2,
    maxCrossAgeBars: 7,
    requirePriceConfirmation: true,
    fastBullSizeMult: 1.08,
    goldenSizeMult: 1.05,
    deathSizeMult: 0.15,
    fastBearSellFraction: 0.6,
    deathSellFraction: 1,
    unknownRegimeSizeMult: 0.5,
    // Conviction has to build further before size moves, and the band it can
    // move within is narrow: at most +8%, and a buy is dropped once regime
    // strength scales it below 60% of intent.
    regimeSaturationPct: 0.09,
    fastSaturationPct: 0.035,
    freshnessWeight: 0.65,
    fastBearBuyMult: 0.4,
    regimeKneeFraction: 0.4,
    minTradeableSizeMult: 0.6,
    minSizeMult: 0.1,
    maxSizeMult: 1.08,
  },
  balanced: {},
  aggressive: {
    fastSeparationPct: 0.001,
    regimeSeparationPct: 0.003,
    confirmBars: 1,
    maxCrossAgeBars: 15,
    requirePriceConfirmation: false,
    fastBullSizeMult: 1.25,
    goldenSizeMult: 1.15,
    deathSizeMult: 0.25,
    fastBearSellFraction: 0.35,
    deathSellFraction: 0.75,
    unknownRegimeSizeMult: 0.85,
    // Reacts to shallower spreads, decays slower with age, and is allowed a
    // wider sizing band in both directions.
    regimeSaturationPct: 0.04,
    fastSaturationPct: 0.018,
    freshnessWeight: 0.35,
    fastBearBuyMult: 0.6,
    regimeKneeFraction: 0.25,
    minTradeableSizeMult: 0.22,
    minSizeMult: 0.1,
    maxSizeMult: 1.45,
  },
};

export function normalizeSmaRisk(risk: unknown): SmaRiskLevel {
  return risk === "conservative" || risk === "aggressive" ? risk : "balanced";
}

/** Rule config in force for a portfolio's risk setting. */
export function smaRulesForRisk(risk: unknown): SmaCrossRuleConfig {
  return { ...DEFAULT_SMA_CROSS_RULES, ...OVERRIDES[normalizeSmaRisk(risk)] };
}

/** Short human summary of what the risk setting changes about SMA rules. */
export function smaRiskSummary(risk: unknown): string {
  const level = normalizeSmaRisk(risk);
  const cfg = smaRulesForRisk(level);
  const sep = (cfg.fastSeparationPct * 100).toFixed(2);
  const death = `a full-strength death regime sizes buys ×${cfg.deathSizeMult.toFixed(
    2,
  )}, and buys below ×${cfg.minTradeableSizeMult.toFixed(2)} are skipped`;
  return `${level}: crosses need ${sep}% separation and ${cfg.confirmBars} bar${
    cfg.confirmBars === 1 ? "" : "s"
  } of confirmation, act within ${cfg.maxCrossAgeBars} sessions, ${death}. Size scales with conviction between ×${cfg.minSizeMult.toFixed(
    2,
  )} and ×${cfg.maxSizeMult.toFixed(2)}, saturating at a ${(cfg.regimeSaturationPct * 100).toFixed(
    1,
  )}% SMA50/200 spread.`;
}
