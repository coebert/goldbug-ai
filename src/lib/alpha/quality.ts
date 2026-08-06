// Quality — driven by the company's PUBLISHED FINANCIALS when they exist.
//
// `f.fundamentals_score` carries the scored reported accounts (margins, returns
// on capital, leverage, cash generation, valuation, consensus estimates). When
// present it is the dominant input and is weighted by how much the company has
// actually disclosed; disclosed financial red flags subtract directly.
//
// When no accounts exist (ETFs, commodities, FX, crypto) or the provider has no
// coverage, the model falls back to the original price-based proxy:
//   • Low daily volatility (<2%)
//   • BB width in a reasonable band (not squeeze, not blow-off)
//   • Positive news sentiment with 2+ contributors
//   • Cross-sectional rank in the top half of the universe
//   • Weekly trend up
// Penalised in violent regimes via the ATR% multiplier.
import { clamp1, type AlphaScore, type FeatureLike } from "./types";

export function scoreQuality(f: FeatureLike): AlphaScore {
  const parts: number[] = [];
  const notes: string[] = [];

  if (f.vol20d != null) {
    parts.push(Math.tanh((0.02 - f.vol20d) * 40)); // 2% vol → 0
    if (f.vol20d < 0.015) notes.push(`low vol ${(f.vol20d * 100).toFixed(1)}%`);
  }
  if (f.bb_width != null) {
    // Prefer 3–8% width; squeeze (<2%) or blow-off (>15%) is penalised.
    const w = f.bb_width;
    const score = w < 0.02 ? -0.4 : w > 0.15 ? -0.6 : 0.5;
    parts.push(score);
  }
  if (f.news_score != null && f.news_contributors >= 2) {
    parts.push(Math.tanh(f.news_score * 2));
    if (f.news_score > 0.2) notes.push(`news+${f.news_score.toFixed(2)}`);
  }
  const pct = f.rank_info?.percentile;
  if (pct != null) {
    parts.push((pct - 0.5) * 2); // percentile 0.75 → 0.5
    if (pct > 0.7) notes.push(`rank p${Math.round(pct * 100)}`);
  }
  if (f.weekly_trend_up) parts.push(0.4);

  const proxy = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;

  const fund = f.fundamentals_score;
  if (fund && fund.coverage > 0) {
    // Weight fundamentals by disclosure depth: full coverage (6 pillars) puts
    // 75% of the quality signal on the reported accounts, thin coverage less.
    const w = 0.75 * Math.min(1, fund.coverage / 6);
    const blended = fund.score * w + proxy * (1 - w);
    notes.unshift(`financials ${fund.score >= 0 ? "+" : ""}${fund.score.toFixed(2)} (${fund.coverage}/6)`);
    if (fund.flags?.length) notes.push(fund.flags.slice(0, 2).join("; "));
    return {
      symbol: f.symbol,
      kind: "quality",
      score: clamp1(blended),
      reason: notes.join(", "),
    };
  }

  return {
    symbol: f.symbol,
    kind: "quality",
    score: clamp1(proxy),
    reason: notes.length ? notes.join(", ") : "neutral quality (no published financials)",
  };
}
