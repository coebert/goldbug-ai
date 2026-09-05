/**
 * Extends the training set backwards, past the day this engine started keeping
 * `decisions` rows.
 *
 * The recorded decision history is only a few months long — far too short for
 * the model to learn anything about how these names behave across a full cycle.
 * Everything the engine feeds the AI on a live day is derived from daily bars,
 * and `price_cache` holds decades of them, so for every symbol this account has
 * ever traded or looked at we can rebuild the same technical snapshot on any
 * past date and label it with the same forward return.
 *
 * What these rows cannot carry: news sentiment (not archived that far back),
 * the book's own state (there was no book) and the macro/sector context blocks.
 * Those features stay null, which the fit already treats as neutral. They also
 * carry a smaller weight than a real recorded decision day, so the account's own
 * observed behaviour still dominates the fit — the long history only fills in
 * the price/trend/volatility relationships that a 70-day sample cannot see.
 */

import type { Candle } from "../market-data.server";
import { sma, rsi, pctChange, dailyVolatility } from "../market-data.server";
import {
  macd,
  bollingerWidth,
  atrPct,
  averageDailyVolume,
  volumeWeightedMomentum,
  weeklySnapshot,
  stochastic,
} from "../signals-extended.server";
import { detectBreakout } from "../alpha/breakout";
import { computeSmaCrossState } from "../alpha/sma-cross-rules";
import { computeCrossSectionalRanks } from "../cross-sectional-ranking.server";
import { withContext, withPf, NEUTRAL_PF, NEUTRAL_SX, NEUTRAL_MX, type AnyRow } from "./features";

/** Bars of context each synthetic snapshot is computed from. */
const WINDOW = 260;
/** Minimum bars before a snapshot is trustworthy (SMA50 / RSI / MACD need room). */
const MIN_BARS = 80;

export type HistoricalCandidate = {
  date: string;
  symbol: string;
  row: AnyRow;
};

type Feat = {
  symbol: string;
  change5d: number | null;
  change30d: number | null;
  vol20d: number | null;
  bb_width: number | null;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  weekly_trend_up: boolean;
  macd_hist: number | null;
  vw_momentum_10d: number | null;
  row: AnyRow;
};

function snapshot(symbol: string, candles: Candle[], i: number): Feat | null {
  const start = Math.max(0, i - WINDOW + 1);
  const win = candles.slice(start, i + 1);
  if (win.length < MIN_BARS) return null;
  const closes = win.map((c) => c.close);
  const price = closes[closes.length - 1]!;
  if (!(price > 0)) return null;

  const m = macd(closes);
  const wk = weeklySnapshot(win);
  const base = {
    symbol,
    price,
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
    atr_pct: atrPct(win, 14),
    adv_20d: averageDailyVolume(win, 20),
    vw_momentum_10d: volumeWeightedMomentum(win, 10),
    weekly_trend_up: wk?.weekly_trend_up ?? false,
    weekly_rsi14: wk?.weekly_rsi14 ?? null,
    stochastic: stochastic(win),
    sma_cross: computeSmaCrossState(closes),
    breakout: detectBreakout(win),
    // Not recoverable this far back — left null so the fit reads them neutral.
    news_score: null,
    news_momentum: null,
    event_features: null,
    fundamentals: null,
    fundamentals_score: null,
    rank_info: null as unknown,
  };

  return {
    symbol,
    change5d: base.change5d,
    change30d: base.change30d,
    vol20d: base.vol20d,
    bb_width: base.bb_width,
    sma20: base.sma20,
    sma50: base.sma50,
    rsi14: base.rsi14,
    weekly_trend_up: base.weekly_trend_up,
    macd_hist: base.macd_hist,
    vw_momentum_10d: base.vw_momentum_10d,
    row: base as AnyRow,
  };
}

/**
 * Rebuild candidate snapshots for every `strideDays`-th trading day strictly
 * before `before`, across the symbols the account has history in.
 *
 * `strideDays` deliberately samples rather than taking every bar: consecutive
 * days share almost all of their signal and their forward windows overlap, so
 * a daily sample would inflate the row count without adding information.
 */
export function buildHistoricalCandidates(opts: {
  candlesBySymbol: Map<string, Candle[]>;
  from: string;
  before: string;
  strideDays?: number;
}): HistoricalCandidate[] {
  const stride = Math.max(1, opts.strideDays ?? 5);

  // Index every symbol's bars by date so a day can be assembled cross-sectionally.
  const indexBySymbol = new Map<string, Map<string, number>>();
  const dateSet = new Set<string>();
  for (const [symbol, candles] of opts.candlesBySymbol) {
    const idx = new Map<string, number>();
    candles.forEach((c, i) => {
      idx.set(c.date, i);
      if (c.date >= opts.from && c.date < opts.before) dateSet.add(c.date);
    });
    indexBySymbol.set(symbol, idx);
  }

  const dates = Array.from(dateSet).sort();
  const out: HistoricalCandidate[] = [];

  for (let d = 0; d < dates.length; d += stride) {
    const date = dates[d]!;
    const feats: Feat[] = [];
    for (const [symbol, candles] of opts.candlesBySymbol) {
      const i = indexBySymbol.get(symbol)?.get(date);
      if (i === undefined) continue;
      const f = snapshot(symbol, candles, i);
      if (f) feats.push(f);
    }
    if (feats.length === 0) continue;

    // Same cross-sectional ranking the live engine applies to its universe.
    const ranks = computeCrossSectionalRanks(feats);
    for (const f of feats) {
      f.row["rank_info"] = ranks.get(f.symbol) ?? null;
      out.push({
        date,
        symbol: f.symbol,
        row: withContext(withPf(f.row, NEUTRAL_PF), { date, sx: NEUTRAL_SX, mx: NEUTRAL_MX }),
      });
    }
  }

  return out;
}
