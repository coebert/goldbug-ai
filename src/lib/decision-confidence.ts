// Two per-decision readouts for the rationale panel:
//
//   1. `computeDecisionConfidence` — how much corroborating evidence the AI
//      had when it acted, expressed as a 0–100 score with the components that
//      produced it. Everything is derived from the persisted decision row, so
//      the number is reproducible and never re-runs a model.
//   2. `buildRiskLimitSummary` — the guardrails the selected risk level put
//      around that decision (position caps, stop/target, loss halts), with
//      utilisation where the position size is known.

export type ConfidenceComponent = {
  key: string;
  label: string;
  /** Normalised 0..1 reading for this component. */
  value: number;
  /** Relative weight in the blend. */
  weight: number;
  detail: string;
};

export type DecisionConfidence = {
  /** 0..100. */
  score: number;
  band: "low" | "moderate" | "high";
  /** 0..1 — how much of the evidence set was actually available. */
  coverage: number;
  components: ConfidenceComponent[];
  summary: string;
};

export type RiskLimitItem = {
  key: string;
  label: string;
  value: string;
  detail: string;
  /** 0..1 when the decision's own size can be compared to the limit. */
  utilisation: number | null;
};

export type RiskLimitSummary = {
  /** Dial position 1..5 when known. */
  level: number | null;
  levelName: string;
  items: RiskLimitItem[];
  notes: string[];
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const pct = (v: number, dp = 0) => `${(v * 100).toFixed(dp)}%`;

export function confidenceBand(score: number): DecisionConfidence["band"] {
  if (score >= 67) return "high";
  if (score >= 40) return "moderate";
  return "low";
}

/**
 * Blend the evidence recorded with the decision into one confidence reading.
 * Missing components are dropped rather than scored zero, so a sparse audit
 * row yields a low-coverage (but honest) score instead of a fake 0.
 */
export function computeDecisionConfidence(input: {
  action: "buy" | "sell" | "hold" | null;
  /** `market_inputs` blob from the audit row. */
  marketInputs?: unknown;
  /** Risk:reward implied by the derived levels, when available. */
  riskReward?: number | null;
  /** Count of relevant headlines/events found around the decision. */
  eventCount?: number;
}): DecisionConfidence {
  const mi = obj(input.marketInputs) ?? {};
  const feat = obj(mi["features"]) ?? {};
  const bullish = input.action !== "sell";
  const parts: ConfidenceComponent[] = [];

  const regime = obj(mi["regime"]);
  const regimeConf = num(regime?.["confidence"]);
  if (regimeConf != null) {
    const name = String(regime?.["regime"] ?? "regime");
    const aligned = /bull|risk_on|quiet/.test(name) === bullish;
    parts.push({
      key: "regime",
      label: "Regime alignment",
      value: clamp01(aligned ? regimeConf : 1 - regimeConf),
      weight: 1.2,
      detail: `${name} read at ${pct(clamp01(regimeConf))} confidence, ${aligned ? "aligned with" : "against"} a ${input.action ?? "neutral"} call`,
    });
  }

  const rank = obj(feat["rank_info"]);
  const rankPctl = num(rank?.["percentile"]) ?? num(rank?.["pct"]);
  const rankScore = num(rank?.["score"]) ?? num(rank?.["z"]);
  if (rankPctl != null || rankScore != null) {
    const v = rankPctl != null ? clamp01(rankPctl > 1 ? rankPctl / 100 : rankPctl) : clamp01((rankScore! + 2) / 4);
    parts.push({
      key: "rank",
      label: "Cross-sectional rank",
      value: bullish ? v : 1 - v,
      weight: 1.2,
      detail: rankPctl != null ? `peer percentile ${pct(v)}` : `peer z-score ${rankScore!.toFixed(2)}`,
    });
  }

  const fundScore = num(obj(feat["fundamentals_score"])?.["score"]) ?? num(feat["fundamentals_score"]);
  if (fundScore != null) {
    const v = clamp01(Math.abs(fundScore) > 1 ? fundScore / 100 : (fundScore + 1) / 2);
    parts.push({
      key: "fundamentals",
      label: "Fundamental health",
      value: bullish ? v : 1 - v,
      weight: 0.9,
      detail: `fundamentals score ${fundScore.toFixed(2)}`,
    });
  }

  const news = num(feat["news_score"]);
  if (news != null) {
    const v = clamp01((news + 1) / 2);
    parts.push({
      key: "news",
      label: "News sentiment",
      value: bullish ? v : 1 - v,
      weight: 0.8,
      detail: `sentiment ${news.toFixed(2)} from ${num(feat["news_contributors"]) ?? 0} headline(s)`,
    });
  }

  const breakout = obj(mi["breakout"]) ?? obj(feat["breakout"]);
  const bQuality = num(breakout?.["quality"]) ?? num(breakout?.["strength"]);
  if (breakout && (bQuality != null || breakout["applies"] === true)) {
    parts.push({
      key: "breakout",
      label: "Breakout quality",
      value: clamp01(bQuality ?? 0.5),
      weight: 0.7,
      detail: bQuality != null ? `quality ${bQuality.toFixed(2)}` : "breakout structure detected",
    });
  }

  const sectorStrength = num(obj(mi["sector"])?.["strength"]);
  if (sectorStrength != null) {
    const v = clamp01(Math.abs(sectorStrength) > 1 ? sectorStrength / 100 : (sectorStrength + 1) / 2);
    parts.push({
      key: "sector",
      label: "Sector rotation",
      value: bullish ? v : 1 - v,
      weight: 0.7,
      detail: `sector strength ${sectorStrength.toFixed(2)}`,
    });
  }

  const rr = num(input.riskReward);
  if (rr != null && rr > 0) {
    parts.push({
      key: "risk_reward",
      label: "Risk:reward",
      value: clamp01(rr / 3),
      weight: 1,
      detail: `${rr.toFixed(2)}:1 target vs stop (3:1 scores full marks)`,
    });
  }

  const evidence = input.eventCount ?? 0;
  if (evidence > 0) {
    parts.push({
      key: "evidence",
      label: "Corroborating events",
      value: clamp01(evidence / 5),
      weight: 0.5,
      detail: `${evidence} relevant headline${evidence === 1 ? "" : "s"} / market event${evidence === 1 ? "" : "s"}`,
    });
  }

  // Max weight the blend could have carried if every input were recorded.
  const MAX_WEIGHT = 1.2 + 1.2 + 0.9 + 0.8 + 0.7 + 0.7 + 1 + 0.5;
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const raw = totalWeight > 0 ? parts.reduce((a, p) => a + p.value * p.weight, 0) / totalWeight : 0;
  const coverage = clamp01(totalWeight / MAX_WEIGHT);

  // Thin evidence pulls the reading toward neutral rather than inflating it.
  const shrunk = 0.5 + (raw - 0.5) * (0.55 + 0.45 * coverage);
  const score = totalWeight > 0 ? Math.round(clamp01(shrunk) * 100) : 0;
  const band = confidenceBand(score);

  const top = [...parts].sort((a, b) => b.value * b.weight - a.value * a.weight)[0];
  const summary =
    totalWeight === 0
      ? "No structured evidence was recorded with this decision, so confidence is unscored."
      : `${band === "high" ? "High" : band === "moderate" ? "Moderate" : "Low"} confidence (${score}/100) from ${parts.length} evidence stream${parts.length === 1 ? "" : "s"}` +
        (top ? `, led by ${top.label.toLowerCase()}.` : ".");

  return {
    score,
    band,
    coverage,
    components: parts.sort((a, b) => b.weight * b.value - a.weight * a.value),
    summary,
  };
}

export type RiskLimitConfig = {
  per_symbol_limit_pct?: number | null;
  asset_class_limits?: Record<string, number> | null;
  stop_loss_pct?: number | null;
  take_profit_pct?: number | null;
  take_profit_enabled?: boolean | null;
  max_hold_days?: number | null;
  max_daily_loss_pct?: number | null;
  max_drawdown_halt_pct?: number | null;
  vol_target_pct?: number | null;
  size_multiplier?: number | null;
  trading_style?: string | null;
};

/** Guardrails the chosen risk level placed around this decision. */
export function buildRiskLimitSummary(input: {
  level: number | null;
  levelName: string;
  config: RiskLimitConfig | null;
  assetClass?: string | null;
  /** Decision notional in portfolio currency. */
  notional?: number | null;
  /** Portfolio equity in the same currency, for utilisation. */
  equity?: number | null;
  /** Hard per-position cap from the mode profile (fallback for the dial cap). */
  maxPositionPct?: number | null;
  maxNewPositionsPerDay?: number | null;
}): RiskLimitSummary {
  const cfg = input.config ?? {};
  const items: RiskLimitItem[] = [];
  const notes: string[] = [];

  const equity = num(input.equity);
  const notional = num(input.notional);
  const weight = equity && equity > 0 && notional != null ? Math.abs(notional) / equity : null;

  const symbolCap = num(cfg.per_symbol_limit_pct) ?? num(input.maxPositionPct);
  if (symbolCap != null) {
    items.push({
      key: "per_symbol",
      label: "Per-position cap",
      value: pct(symbolCap),
      detail:
        weight != null
          ? `this trade is ${pct(weight, 1)} of equity`
          : "share of portfolio equity any one symbol may reach",
      utilisation: weight != null ? clamp01(weight / symbolCap) : null,
    });
  }

  const ac = (input.assetClass ?? "").toLowerCase();
  const acCap = ac ? num(cfg.asset_class_limits?.[ac]) : null;
  if (acCap != null) {
    items.push({
      key: "asset_class",
      label: `${ac.toUpperCase()} sleeve cap`,
      value: pct(acCap),
      detail: `maximum share of equity across all ${ac} positions`,
      utilisation: weight != null ? clamp01(weight / acCap) : null,
    });
  }

  const stop = num(cfg.stop_loss_pct);
  if (stop != null) {
    items.push({
      key: "stop",
      label: "Hard stop",
      value: pct(stop, 1),
      detail: "widest loss allowed before the position is cut",
      utilisation: null,
    });
  }

  const tp = num(cfg.take_profit_pct);
  if (tp != null) {
    items.push({
      key: "take_profit",
      label: "Take profit",
      value: cfg.take_profit_enabled === false ? "off (let winners run)" : pct(tp, 1),
      detail: "profit target the exit leg aims for",
      utilisation: null,
    });
  }

  const hold = num(cfg.max_hold_days);
  if (hold != null) {
    items.push({
      key: "max_hold",
      label: "Max hold",
      value: hold > 0 ? `${hold} days` : "no time stop",
      detail: cfg.trading_style === "swing" ? "swing horizon" : "position horizon",
      utilisation: null,
    });
  }

  const daily = num(cfg.max_daily_loss_pct);
  if (daily != null) {
    items.push({
      key: "daily_loss",
      label: "Daily loss halt",
      value: pct(daily, 1),
      detail: "one-day drawdown that pauses new buys",
      utilisation: null,
    });
  }

  const dd = num(cfg.max_drawdown_halt_pct);
  if (dd != null) {
    items.push({
      key: "drawdown",
      label: "Drawdown halt",
      value: pct(dd, 1),
      detail: "peak-to-trough loss that trips the circuit breaker",
      utilisation: null,
    });
  }

  const vol = num(cfg.vol_target_pct);
  if (vol != null) {
    items.push({
      key: "vol_target",
      label: "Volatility target",
      value: pct(vol, 2),
      detail: "daily volatility each position is sized toward",
      utilisation: null,
    });
  }

  const newPos = num(input.maxNewPositionsPerDay);
  if (newPos != null) {
    items.push({
      key: "new_positions",
      label: "New positions / day",
      value: String(newPos),
      detail: "how many fresh names the engine may open in one session",
      utilisation: null,
    });
  }

  const mult = num(cfg.size_multiplier);
  if (mult != null && Math.abs(mult - 1) > 0.001) {
    notes.push(`Buy budgets are scaled ${mult.toFixed(2)}x by this risk level.`);
  }
  if (weight != null && symbolCap != null && weight > symbolCap) {
    notes.push("This position sits above the per-position cap — trims take priority over new buys.");
  }
  if (equity == null) notes.push("Utilisation is unavailable because portfolio equity was not recorded.");

  return { level: input.level, levelName: input.levelName, items, notes };
}
