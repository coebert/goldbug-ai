// J. Ensemble second opinion — deterministic trend + mean-reversion + momentum
// composite. Runs alongside the AI. When it strongly disagrees, we halve size
// on the disputed order and record the divergence.

export type EnsembleFeature = {
  symbol: string;
  price: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  change5d: number | null;
  change30d: number | null;
};

export type EnsembleVote = {
  side: "buy" | "sell" | "hold";
  score: number; // -1..+1 (positive = long-favouring)
  reasons: string[];
};

export function ensembleVote(f: EnsembleFeature): EnsembleVote {
  const reasons: string[] = [];
  let score = 0;

  // Trend
  if (f.sma20 != null && f.sma50 != null) {
    if (f.sma20 > f.sma50 && f.price > f.sma50) { score += 0.4; reasons.push("uptrend (SMA20>SMA50, px>SMA50)"); }
    else if (f.sma20 < f.sma50 && f.price < f.sma50) { score -= 0.4; reasons.push("downtrend"); }
  }

  // Mean reversion (RSI)
  if (f.rsi14 != null) {
    if (f.rsi14 < 30) { score += 0.25; reasons.push(`RSI ${f.rsi14.toFixed(0)} oversold`); }
    else if (f.rsi14 > 70) { score -= 0.25; reasons.push(`RSI ${f.rsi14.toFixed(0)} overbought`); }
  }

  // Momentum
  if (f.change30d != null) {
    if (f.change30d > 0.05) { score += 0.2; reasons.push(`+${(f.change30d * 100).toFixed(1)}% 30d`); }
    else if (f.change30d < -0.05) { score -= 0.2; reasons.push(`${(f.change30d * 100).toFixed(1)}% 30d`); }
  }
  if (f.change5d != null) {
    if (f.change5d > 0.03) score += 0.1;
    else if (f.change5d < -0.03) score -= 0.1;
  }

  score = Math.max(-1, Math.min(1, score));
  const side: EnsembleVote["side"] = score >= 0.35 ? "buy" : score <= -0.35 ? "sell" : "hold";
  return { side, score: Number(score.toFixed(2)), reasons };
}

export type Disagreement = {
  symbol: string;
  ai_side: "buy" | "sell";
  ensemble: EnsembleVote;
  strong: boolean; // opposite sides
};

export function scoreDisagreement(aiSide: "buy" | "sell", vote: EnsembleVote): Disagreement["strong"] {
  if (vote.side === "hold") return false;
  return vote.side !== aiSide && Math.abs(vote.score) >= 0.35;
}
