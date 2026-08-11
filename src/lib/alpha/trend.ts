// Trend model — rewards durable, low-noise up-trends.
// Signals combined (equally weighted, then clamped):
//   • SMA20 above SMA50 with price above SMA20 (structural uptrend)
//   • 30d change > 0
//   • Weekly trend up + weekly RSI in [50, 70]
//   • MACD histogram > 0 (or fresh bullish cross)
//   • Volume-weighted 10d momentum > 0
// Penalised when ATR% is extreme (>8%) — trend-following on parabolic
// names decays hard.
import { clamp1, type AlphaScore, type FeatureLike } from "./types";

export function scoreTrend(f: FeatureLike): AlphaScore {
  const parts: number[] = [];
  const notes: string[] = [];

  if (f.sma20 != null && f.sma50 != null) {
    const structural = f.sma20 > f.sma50 && f.price > f.sma20;
    parts.push(structural ? 1 : f.price < f.sma50 ? -1 : 0);
    if (structural) notes.push("px>SMA20>SMA50");
  }
  // Long-term regime: SMA50 vs SMA200 (golden / death cross) plus price side.
  if (f.sma50 != null && f.sma200 != null && f.sma200 > 0) {
    const golden = f.sma50 > f.sma200;
    const above = f.price > f.sma200;
    if (golden && above) {
      parts.push(1);
      notes.push("SMA50>SMA200 (golden)");
    } else if (!golden && !above) {
      parts.push(-1);
      notes.push("SMA50<SMA200 (death)");
    } else {
      parts.push(golden ? 0.3 : -0.3);
      notes.push(golden ? "golden, px<SMA200" : "death, px>SMA200");
    }
  }
  if (f.change30d != null) {
    parts.push(Math.tanh(f.change30d * 5)); // 20% move ≈ 0.76
    if (f.change30d > 0.05) notes.push(`+${(f.change30d * 100).toFixed(1)}%/30d`);
  }
  if (f.weekly_trend_up) {
    const rok = f.weekly_rsi14 != null && f.weekly_rsi14 >= 50 && f.weekly_rsi14 <= 70;
    parts.push(rok ? 1 : 0.4);
    notes.push(`wkly↑${rok ? " RSI-ok" : ""}`);
  } else {
    parts.push(-0.3);
  }
  if (f.macd_hist != null) {
    parts.push(Math.tanh(f.macd_hist * 20));
    if (f.macd_bull_cross) notes.push("MACD↑cross");
  }
  if (f.vw_momentum_10d != null) {
    parts.push(Math.tanh(f.vw_momentum_10d * 10));
  }

  let raw = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  // Vol penalty — trend model doesn't want parabolic ATR.
  if (f.atr_pct != null && f.atr_pct > 0.08) raw *= 0.6;
  if (f.atr_pct != null && f.atr_pct > 0.12) raw *= 0.5;

  return {
    symbol: f.symbol,
    kind: "trend",
    score: clamp1(raw),
    reason: notes.length ? notes.join(", ") : "flat trend inputs",
  };
}
