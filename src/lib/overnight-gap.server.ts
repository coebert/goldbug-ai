// Overnight-gap guard. If a symbol shows a fresh, very large intraday move
// (proxy for a probable gap the next open), we skip new buys. Uses last few
// candles vs the ATR to detect an outsized move.

import { getDailyCandles, dailyVolatility } from "./market-data.server";

export type GapVerdict = {
  symbol: string;
  triggered: boolean;
  z: number | null;
  note: string;
};

/**
 * Returns triggered=true when the most recent 1-day return is > 2σ vs the
 * 20-day daily volatility.
 */
export async function checkOvernightGap(symbol: string, asOf: string): Promise<GapVerdict> {
  try {
    const candles = await getDailyCandles(symbol, 30, asOf);
    if (candles.length < 5) return { symbol, triggered: false, z: null, note: "insufficient candles" };
    const closes = candles.map((c) => c.close);
    const vol = dailyVolatility(closes, 20);
    if (!vol || vol <= 0) return { symbol, triggered: false, z: null, note: "no vol" };
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    if (!prev) return { symbol, triggered: false, z: null, note: "no prev" };
    const r = (last - prev) / prev;
    const z = r / vol;
    const triggered = Math.abs(z) >= 2;
    return {
      symbol,
      triggered,
      z,
      note: triggered ? `overnight-gap guard: 1d move ${(r * 100).toFixed(2)}% is ${z.toFixed(1)}σ` : "gap ok",
    };
  } catch (e) {
    return { symbol, triggered: false, z: null, note: `gap check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
