// Plain-language explanation of how the SMA trend model influenced one trade.
//
// Pure and deterministic: given the SMA snapshot recorded on the order and
// the portfolio's risk setting, it re-derives exactly which rule fired, how
// strong the signal was, and what the rule did to the order (blocked,
// upsized, halved, forced an exit...). No I/O, so the UI, tests and the
// order-explanation writer all share one source of truth.

import {
  smaCrossBuyRule,
  smaCrossSellRule,
  type SmaCrossState,
} from "./alpha/sma-cross-rules";
import { normalizeSmaRisk, smaRiskSummary, smaRulesForRisk, type SmaRiskLevel } from "./alpha/sma-risk-profiles";

export type SmaCrossDirection = "bull" | "bear" | "none";
export type SmaInfluenceKind =
  | "blocked"
  | "upsized"
  | "downsized"
  | "neutral"
  | "exit"
  | "trim"
  | "unavailable";

export type SmaExplanation = {
  available: boolean;
  riskLevel: SmaRiskLevel;
  riskSummary: string;
  values: {
    price: number | null;
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
    /** (SMA20 - SMA50) / SMA50, as a percentage. */
    fastSpreadPct: number | null;
    /** (SMA50 - SMA200) / SMA200, as a percentage. */
    regimeSpreadPct: number | null;
    /** (price - SMA20) / SMA20, as a percentage. */
    priceVsFastPct: number | null;
  };
  fast: {
    direction: SmaCrossDirection;
    /** True when a *fresh confirmed* cross fired, not just a standing order. */
    fresh: boolean;
    ageBars: number | null;
    label: string;
  };
  regime: {
    state: "golden" | "death" | "unknown";
    fresh: boolean;
    ageBars: number | null;
    label: string;
  };
  /** 0-100 conviction in the trend read (separation × freshness × alignment). */
  strength: number;
  strengthLabel: "very weak" | "weak" | "moderate" | "strong" | "very strong";
  influence: {
    kind: SmaInfluenceKind;
    /** Buy-side size multiplier applied to the intended notional. */
    sizeMultiplier: number | null;
    /** Sell-side fraction of the position the rule wanted closed. */
    sellFraction: number | null;
    headline: string;
    detail: string;
  };
  quality: {
    tier: SmaCrossState["quality"] | "missing";
    bars: number;
    droppedBars: number;
    warnings: string[];
  };
  bullets: string[];
};

const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v * 100);
const fmtPct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

function strengthLabel(score: number): SmaExplanation["strengthLabel"] {
  if (score >= 80) return "very strong";
  if (score >= 60) return "strong";
  if (score >= 40) return "moderate";
  if (score >= 20) return "weak";
  return "very weak";
}

/**
 * Signal strength on 0-100. Three equally weighted parts:
 *  • fast separation, saturating at 3% (a wider gap is a cleaner trend)
 *  • regime separation, saturating at 8%
 *  • freshness of whichever cross fired, decaying over `maxCrossAgeBars`
 * Alignment (fast and regime pointing the same way) adds a final bonus.
 */
export function smaSignalStrength(state: SmaCrossState, maxCrossAgeBars: number): number {
  const fastSep = Math.min(Math.abs(state.fastSeparationPct ?? 0) / 0.03, 1);
  const regimeSep = Math.min(Math.abs(state.regimeSeparationPct ?? 0) / 0.08, 1);
  const age = state.fastCrossAgeBars ?? state.regimeCrossAgeBars;
  const freshness =
    age == null ? 0.35 : Math.max(0, 1 - age / Math.max(1, maxCrossAgeBars));
  const bullish = state.fastCross === "bull" || (state.fastSeparationPct ?? 0) > 0;
  const golden = state.regime === "golden";
  const aligned = state.regime == null ? 0 : bullish === golden ? 1 : 0;
  const raw = 0.3 * fastSep + 0.3 * regimeSep + 0.25 * freshness + 0.15 * aligned;
  return Math.round(Math.max(0, Math.min(1, raw)) * 100);
}

export function buildSmaExplanation(args: {
  state: SmaCrossState | null | undefined;
  side: "buy" | "sell";
  riskLevel: unknown;
}): SmaExplanation {
  const riskLevel = normalizeSmaRisk(args.riskLevel);
  const riskSummary = smaRiskSummary(riskLevel);
  const cfg = smaRulesForRisk(riskLevel);
  const state = args.state ?? null;

  if (!state) {
    return {
      available: false,
      riskLevel,
      riskSummary,
      values: {
        price: null, sma20: null, sma50: null, sma200: null,
        fastSpreadPct: null, regimeSpreadPct: null, priceVsFastPct: null,
      },
      fast: { direction: "none", fresh: false, ageBars: null, label: "No SMA snapshot recorded" },
      regime: { state: "unknown", fresh: false, ageBars: null, label: "Unknown" },
      strength: 0,
      strengthLabel: "very weak",
      influence: {
        kind: "unavailable",
        sizeMultiplier: null,
        sellFraction: null,
        headline: "SMA model not recorded for this order",
        detail:
          "This trade predates SMA telemetry, or the symbol had no usable price history at decision time. The trend rules neither sized nor blocked it.",
      },
      quality: { tier: "missing", bars: 0, droppedBars: 0, warnings: [] },
      bullets: [],
    };
  }

  const fastSpreadPct =
    state.sma20 != null && state.sma50 ? pct((state.sma20 - state.sma50) / state.sma50) : null;
  const regimeSpreadPct =
    state.sma50 != null && state.sma200 ? pct((state.sma50 - state.sma200) / state.sma200) : null;
  const priceVsFastPct =
    state.sma20 ? pct((state.price - state.sma20) / state.sma20) : null;

  const direction: SmaCrossDirection =
    state.fastCross ?? (fastSpreadPct == null ? "none" : fastSpreadPct > 0 ? "bull" : "bear");

  const fastLabel = state.fastCross
    ? state.fastCross === "bull"
      ? `SMA20 crossed above SMA50${state.fastCrossAgeBars != null ? ` ${state.fastCrossAgeBars} session${state.fastCrossAgeBars === 1 ? "" : "s"} earlier` : ""}`
      : `SMA20 crossed below SMA50${state.fastCrossAgeBars != null ? ` ${state.fastCrossAgeBars} session${state.fastCrossAgeBars === 1 ? "" : "s"} earlier` : ""}`
    : fastSpreadPct == null
      ? "Not enough history for SMA20/50"
      : fastSpreadPct > 0
        ? "SMA20 above SMA50 (no fresh cross)"
        : "SMA20 below SMA50 (no fresh cross)";

  const regimeState: SmaExplanation["regime"]["state"] = state.regimeUnknown
    ? "unknown"
    : (state.regime ?? "unknown");
  const regimeLabel =
    regimeState === "unknown"
      ? `No SMA200 yet — only ${state.bars} bars of history`
      : state.regimeCross
        ? `Fresh ${state.regimeCross} cross${state.regimeCrossAgeBars != null ? ` ${state.regimeCrossAgeBars} session${state.regimeCrossAgeBars === 1 ? "" : "s"} earlier` : ""}`
        : regimeState === "golden"
          ? "Golden regime — SMA50 above SMA200"
          : "Death regime — SMA50 below SMA200";

  const strength = smaSignalStrength(state, cfg.maxCrossAgeBars);

  let kind: SmaInfluenceKind = "neutral";
  let sizeMultiplier: number | null = null;
  let sellFraction: number | null = null;
  let headline = "";
  let detail = "";

  if (args.side === "buy") {
    const rule = smaCrossBuyRule(state, cfg);
    sizeMultiplier = rule.sizeMultiplier;
    if (!rule.allow) {
      kind = "blocked";
      headline = "Trend rules blocked new buys";
      detail = `Under the ${riskLevel} setting, ${rule.reason}. Any buy you see here came from a protective or rebalancing path that bypasses the trend veto.`;
    } else if (rule.sizeMultiplier > 1.001) {
      kind = "upsized";
      headline = `Buy upsized ×${rule.sizeMultiplier.toFixed(2)}`;
      detail = `${rule.reason}. The intended notional was multiplied by ${rule.sizeMultiplier.toFixed(2)} because the trend read supported the entry.`;
    } else if (rule.sizeMultiplier < 0.999) {
      kind = "downsized";
      headline = `Buy cut to ×${rule.sizeMultiplier.toFixed(2)}`;
      detail = `${rule.reason}. The trend read was not clean enough for full size, so the order was scaled back.`;
    } else {
      kind = "neutral";
      headline = "Trend rules left the size unchanged";
      detail = `${rule.reason}. No fresh cross was actionable under the ${riskLevel} thresholds, so the SMA model neither added nor removed size.`;
    }
  } else {
    const rule = smaCrossSellRule(state, cfg);
    sellFraction = rule.sellFraction || null;
    if (rule.sell && rule.sellFraction >= 0.999) {
      kind = "exit";
      headline = "Trend rules closed the position";
      detail = `${rule.reason}. The ${riskLevel} setting exits in full on this signal.`;
    } else if (rule.sell) {
      kind = "trim";
      headline = `Trend rules trimmed ${Math.round(rule.sellFraction * 100)}% of the position`;
      detail = `${rule.reason}. The ${riskLevel} setting sells ${Math.round(rule.sellFraction * 100)}% rather than exiting outright.`;
    } else {
      kind = "neutral";
      headline = "Sell was not triggered by the trend model";
      detail = `No confirmed bear or death cross was actionable under the ${riskLevel} thresholds — this exit came from another rule (stop, target, cash or rebalance).`;
    }
  }

  const bullets: string[] = [
    `Price ${state.price.toFixed(2)} vs SMA20 ${state.sma20?.toFixed(2) ?? "—"} (${fmtPct(priceVsFastPct)})`,
    `SMA20 vs SMA50 spread ${fmtPct(fastSpreadPct)} — threshold ${(cfg.fastSeparationPct * 100).toFixed(2)}%`,
    regimeState === "unknown"
      ? "SMA200 unavailable — regime filter skipped, size reduced instead of guessed"
      : `SMA50 vs SMA200 spread ${fmtPct(regimeSpreadPct)} — threshold ${(cfg.regimeSeparationPct * 100).toFixed(2)}%`,
    `Signal strength ${strength}/100 (${strengthLabel(strength)})`,
  ];
  if (args.side === "buy") {
    const sizing = smaCrossBuyRule(state, cfg).sizing;
    if (sizing) {
      bullets.push(
        `Sizing conviction — regime ${(sizing.components.regimeConviction * 100).toFixed(0)}%, fast cross ${(
          sizing.components.fastConviction * 100
        ).toFixed(0)}% → ×${sizing.mult.toFixed(2)} (allowed ×${cfg.minSizeMult.toFixed(2)}-×${cfg.maxSizeMult.toFixed(2)})`,
      );
    }
  }
  for (const w of state.warnings) bullets.push(w);

  return {
    available: true,
    riskLevel,
    riskSummary,
    values: {
      price: state.price,
      sma20: state.sma20,
      sma50: state.sma50,
      sma200: state.sma200,
      fastSpreadPct,
      regimeSpreadPct,
      priceVsFastPct,
    },
    fast: {
      direction,
      fresh: state.fastCross != null,
      ageBars: state.fastCrossAgeBars,
      label: fastLabel,
    },
    regime: {
      state: regimeState,
      fresh: state.regimeCross != null,
      ageBars: state.regimeCrossAgeBars,
      label: regimeLabel,
    },
    strength,
    strengthLabel: strengthLabel(strength),
    influence: {
      kind,
      sizeMultiplier,
      sellFraction,
      headline,
      // Bar counts are relative to the decision bar, not to now — keep the
      // wording clock-free so the panel stays deterministic over time.
      detail: detail.replace(/(\d+)d ago\b/g, "$1 bars before the trade"),
    },
    quality: {
      tier: state.quality,
      bars: state.bars,
      droppedBars: state.droppedBars,
      warnings: state.warnings,
    },
    bullets,
  };
}
