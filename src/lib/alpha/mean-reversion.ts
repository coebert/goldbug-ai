// Mean-reversion model — rewards short-term dislocations against a rising
// longer-term trend (buy dips in uptrends, avoid falling knives).
// Signals:
//   • RSI14 in [25, 40] AND weekly trend up → strong dip-buy
//   • RSI14 < 25 in downtrend → falling knife → negative
//   • 5d change deeply negative while 30d change positive → dip
//   • MACD bearish cross veto (structure broken)
import { clamp1, type AlphaScore, type FeatureLike } from "./types";

export function scoreMeanReversion(f: FeatureLike): AlphaScore {
  const parts: number[] = [];
  const notes: string[] = [];

  const upTrend = f.weekly_trend_up || (f.sma20 != null && f.sma50 != null && f.sma20 > f.sma50);

  if (f.rsi14 != null) {
    if (f.rsi14 >= 25 && f.rsi14 <= 40 && upTrend) {
      parts.push(1);
      notes.push(`RSI ${f.rsi14.toFixed(0)} dip in uptrend`);
    } else if (f.rsi14 < 25 && !upTrend) {
      parts.push(-1);
      notes.push(`RSI ${f.rsi14.toFixed(0)} falling knife`);
    } else if (f.rsi14 > 75) {
      parts.push(-0.6);
      notes.push(`RSI ${f.rsi14.toFixed(0)} overbought`);
    } else {
      parts.push(0);
    }
  }

  if (f.change5d != null && f.change30d != null) {
    if (f.change5d < -0.04 && f.change30d > 0.03) {
      parts.push(0.8);
      notes.push(`-${Math.abs(f.change5d * 100).toFixed(1)}%/5d vs +${(f.change30d * 100).toFixed(1)}%/30d`);
    } else if (f.change5d < -0.08 && f.change30d < 0) {
      parts.push(-0.8);
    }
  }

  // Stochastic timing leg — a %K/%D upturn out of oversold is the classic
  // low-risk dip entry; overbought and rolling over is the worst one.
  const st = f.stochastic;
  if (st && Number.isFinite(st.k)) {
    if (st.bull_cross_from_oversold) {
      parts.push(1);
      notes.push(`stoch %K ${st.k.toFixed(0)} cross out of oversold`);
    } else if (st.oversold && st.rising) {
      parts.push(0.6);
      notes.push(`stoch %K ${st.k.toFixed(0)} turning up`);
    } else if (st.overbought && !st.rising) {
      parts.push(-0.8);
      notes.push(`stoch %K ${st.k.toFixed(0)} overbought rollover`);
    } else if (st.overbought) {
      parts.push(-0.4);
    } else {
      parts.push(0);
    }
  }

  if (f.macd_bear_cross) {
    parts.push(-0.5);
    notes.push("MACD↓cross veto");
  }

  const raw = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return {
    symbol: f.symbol,
    kind: "mean_reversion",
    score: clamp1(raw),
    reason: notes.length ? notes.join(", ") : "no dislocation",
  };
}
