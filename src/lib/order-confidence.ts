/**
 * Per-order confidence score.
 *
 * A transparent, deterministic re-evaluation of how confident we should
 * be in an AI-proposed order, blending three inputs:
 *
 *   1. Base conviction — the model's self-rated conviction for the
 *      order (0..1), captured at prompt time. Defaults to 0.5 when the
 *      model did not emit one.
 *   2. Regime factor — the latest market regime. A fresh regime
 *      transition (today's label differs from yesterday's) cuts
 *      confidence; a stable, high-confidence regime lifts it slightly.
 *   3. News factor — recent related headlines re-weighted for
 *      directional alignment with the order side. Bullish news lifts a
 *      buy and cuts a sell; bearish news does the opposite. Weighted
 *      by each source's credibility.
 *
 * Pure function, no I/O — safe to import anywhere. The `breakdown`
 * array powers the tooltip so users see exactly which inputs moved
 * the score.
 */

export type ConfidenceRegime = {
  regime: string | null;
  confidence: number | null;
  transitioned: boolean | null;
  previous_regime?: string | null;
} | null;

export type ConfidenceNews = {
  headline: string;
  sentiment: number | null;
  source_weight?: number | null;
};

export type ConfidenceInput = {
  side: "buy" | "sell";
  /** Model conviction 0..1. When undefined, we treat the order as neutral (0.5). */
  conviction?: number | null;
  regime?: ConfidenceRegime;
  relatedNews?: ConfidenceNews[];
};

export type ConfidenceBreakdownItem = {
  label: string;
  detail: string;
  /** Signed percentage-point delta vs the base contribution. */
  delta: number;
};

export type ConfidenceResult = {
  /** Integer 0..100. */
  score: number;
  base: number; // 0..1
  regimeFactor: number; // ~0.75..1.05
  newsFactor: number; // ~0.70..1.00
  breakdown: ConfidenceBreakdownItem[];
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function computeRegimeFactor(regime: ConfidenceRegime): { factor: number; item: ConfidenceBreakdownItem } {
  if (!regime || !regime.regime) {
    return {
      factor: 1,
      item: { label: "Regime", detail: "No current regime data — neutral.", delta: 0 },
    };
  }
  const conf = clamp(Number(regime.confidence ?? 0.5), 0, 1);
  if (regime.transitioned) {
    const factor = 0.75;
    return {
      factor,
      item: {
        label: "Regime shift",
        detail: `Fresh transition${regime.previous_regime ? ` from ${regime.previous_regime}` : ""} to ${regime.regime} — confidence trimmed.`,
        delta: Math.round((factor - 1) * 100),
      },
    };
  }
  // Stable regime, centred at 1.0: low classifier confidence trims
  // to 0.90, high boosts to 1.10. Symmetric so gains and losses read
  // the same way in the breakdown.
  const factor = 1 + 0.20 * (conf - 0.5);
  return {
    factor,
    item: {
      label: `Regime steady · ${regime.regime}`,
      detail: `Classifier confidence ${(conf * 100).toFixed(0)}% — score ${factor >= 1 ? "boosted" : "trimmed"}.`,
      delta: Math.round((factor - 1) * 100),
    },
  };
}

function computeNewsFactor(
  side: "buy" | "sell",
  news: ConfidenceNews[] | undefined,
): { factor: number; item: ConfidenceBreakdownItem } {
  if (!news || news.length === 0) {
    return {
      factor: 1,
      item: { label: "News", detail: "No related headlines — neutral.", delta: 0 },
    };
  }
  const sideSign = side === "buy" ? 1 : -1;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const n of news) {
    const sentiment = clamp(Number(n.sentiment ?? 0), -1, 1);
    const weight = clamp(Number(n.source_weight ?? 1), 0, 5);
    if (weight <= 0) continue;
    weightedSum += sentiment * sideSign * weight;
    weightTotal += weight;
  }
  if (weightTotal === 0) {
    return {
      factor: 1,
      item: { label: "News", detail: "Related headlines carried no weight — neutral.", delta: 0 },
    };
  }
  const aligned = clamp(weightedSum / weightTotal, -1, 1);
  // Centred at 1.0: −1 (dead against) → 0.85, +1 (fully with) → 1.15.
  const factor = 1 + 0.15 * aligned;
  const verdict = aligned > 0.15 ? "aligns with" : aligned < -0.15 ? "runs against" : "is mixed on";
  return {
    factor,
    item: {
      label: `News ${verdict} ${side}`,
      detail: `${news.length} recent headline${news.length === 1 ? "" : "s"}, weighted sentiment ${(aligned * 100).toFixed(0)}%.`,
      delta: Math.round((factor - 1) * 100),
    },
  };
}

export function computeOrderConfidence(input: ConfidenceInput): ConfidenceResult {
  const base = clamp(Number(input.conviction ?? 0.5), 0, 1);
  const regime = computeRegimeFactor(input.regime ?? null);
  const news = computeNewsFactor(input.side, input.relatedNews);

  const raw = base * regime.factor * news.factor;
  const score = clamp(Math.round(raw * 100), 0, 100);

  const baseItem: ConfidenceBreakdownItem = {
    label: "Base conviction",
    detail:
      input.conviction == null
        ? "Model did not rate this order — starting from 50%."
        : `Model's own conviction for this order.`,
    delta: Math.round(base * 100),
  };

  return {
    score,
    base,
    regimeFactor: regime.factor,
    newsFactor: news.factor,
    breakdown: [baseItem, regime.item, news.item],
  };
}

/** Coarse label for the badge tone. */
export function confidenceTone(score: number): "high" | "medium" | "low" {
  if (score >= 65) return "high";
  if (score >= 40) return "medium";
  return "low";
}
