// Candidate technical-feature builder for the trading engine (extracted verbatim).
import type { Database } from "@/integrations/supabase/types";
import {
  getDailyCandles,
  primeDailyCandles,
  sma,
  rsi,
  pctChange,
  dailyVolatility,
} from "../market-data.server";
import {
  macd,
  bollingerWidth,
  atrPct,
  averageDailyVolume,
  volumeWeightedMomentum,
  weeklySnapshot,
} from "../signals-extended.server";
import type { SentimentMomentum } from "../sentiment.server";
import type { SymbolEventFeatures } from "../market-events";
import type { RankInfo } from "../cross-sectional-ranking.server";
import type { UniverseSymbol } from "../universe.server";
import type { Fundamentals, FundamentalsScore } from "../fundamentals/types";
import { detectBreakout, type BreakoutEvidence } from "../alpha/breakout";

export function classesFromUniverse(u: unknown): Database["public"]["Enums"]["asset_class"][] {
  if (!Array.isArray(u)) return ["stock", "etf", "crypto", "commodity", "fx"];
  return u.filter(
    (x): x is Database["public"]["Enums"]["asset_class"] =>
      typeof x === "string" && ["stock", "etf", "crypto", "commodity", "fx"].includes(x),
  );
}

export async function buildCandidateFeatures(
  candidates: UniverseSymbol[],
  asOf: string,
) {
  const rows: Array<{
    symbol: string;
    name: string;
    asset_class: string;
    price: number;
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
    rsi14: number | null;
    change5d: number | null;
    change30d: number | null;
    vol20d: number | null;
    macd_hist: number | null;
    macd_bull_cross: boolean;
    macd_bear_cross: boolean;
    bb_width: number | null;
    atr_pct: number | null;
    adv_20d: number | null;
    vw_momentum_10d: number | null;
    weekly_trend_up: boolean;
    weekly_rsi14: number | null;
    // Evidence-based range-breakout state (Donchian base + ATR penetration
    // + volume confirmation + failure history).
    breakout: BreakoutEvidence | null;
    // Sentiment / cooldown are filled in later once news + cooldowns load
    news_score: number | null;
    news_contributors: number;
    news_momentum: SentimentMomentum | null;
    // Typed market-event features derived from the global news feed
    event_features: SymbolEventFeatures | null;
    cooling: boolean;
    // Cross-sectional rank across today's universe (filled in later)
    rank_info: RankInfo | null;
    // Publicly disclosed company financials + their score (filled in later)
    fundamentals: Fundamentals | null;
    fundamentals_score: FundamentalsScore | null;
  }> = [];
  // One bulk `price_cache` read for the whole universe instead of one per
  // symbol per consumer — the rest of the tick then hits the in-memory memo.
  await primeDailyCandles(candidates.map((c) => c.symbol), 260, asOf);
  await Promise.all(
    candidates.map(async (c) => {
      const candles = await getDailyCandles(c.symbol, 260, asOf);
      if (candles.length < 5) return;
      const closes = candles.map((k) => k.close);
      const m = macd(closes);
      const wk = weeklySnapshot(candles);
      rows.push({
        symbol: c.symbol,
        name: c.name,
        asset_class: c.asset_class,
        price: closes[closes.length - 1],
        sma20: sma(closes, 20),
        sma50: sma(closes, 50),
        sma200: sma(closes, 200),
        rsi14: rsi(closes, 14),
        change5d: pctChange(closes, 5),
        change30d: pctChange(closes, 30),
        vol20d: dailyVolatility(closes, 20),
        macd_hist: m ? m.histogram : null,
        macd_bull_cross: m ? m.bullish_cross : false,
        macd_bear_cross: m ? m.bearish_cross : false,
        bb_width: bollingerWidth(closes, 20),
        atr_pct: atrPct(candles, 14),
        adv_20d: averageDailyVolume(candles, 20),
        vw_momentum_10d: volumeWeightedMomentum(candles, 10),
        weekly_trend_up: wk?.weekly_trend_up ?? false,
        weekly_rsi14: wk?.weekly_rsi14 ?? null,
        breakout: detectBreakout(candles),
        news_score: null,
        news_contributors: 0,
        news_momentum: null,
        event_features: null,
        cooling: false,
        rank_info: null,
        fundamentals: null,
        fundamentals_score: null,
      });
    }),
  );
  return rows;
}
