// Per-risk-profile SMA crossover rule configuration.
//
// The backtest (Aug 2026, `price_cache` daily closes) showed the SMA20/50
// cross is the profit driver while the SMA50/200 regime filter is the
// drawdown control. The three risk profiles therefore differ mainly in how
// much confirmation they demand before acting and how hard the death-cross
// regime bites:
//
//   conservative — wide separation bands, two-bar confirmation, death regime
//                  blocks buys outright and exits fully.
//   balanced     — the tuned defaults.
//   aggressive   — narrow bands, stale crosses still tradeable, larger
//                  upsizing, and a death regime that only sizes down.

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
    deathSizeMult: 0,
    fastBearSellFraction: 0.6,
    deathSellFraction: 1,
    unknownRegimeSizeMult: 0.5,
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
  const death =
    cfg.deathSizeMult <= 0 ? "death cross blocks new buys" : `death cross sizes buys ×${cfg.deathSizeMult.toFixed(2)}`;
  return `${level}: crosses need ${sep}% separation and ${cfg.confirmBars} bar${
    cfg.confirmBars === 1 ? "" : "s"
  } of confirmation, act within ${cfg.maxCrossAgeBars} sessions, ${death}.`;
}
