// Quality proxy — since we don't have fundamentals directly, we approximate
// "quality" using low-noise price characteristics and cross-sectional rank:
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

  const raw = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return {
    symbol: f.symbol,
    kind: "quality",
    score: clamp1(raw),
    reason: notes.length ? notes.join(", ") : "neutral quality",
  };
}
