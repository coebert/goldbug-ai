// Extended technical signals: MACD, Bollinger Band width, ATR,
// weekly SMA/RSI alignment, average daily volume, and volume-weighted momentum.
// All functions are pure and operate on candle arrays already fetched by
// market-data.server.ts.

import type { Candle } from "./market-data.server";
import { rsi, sma } from "./market-data.server";

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // seed with SMA of the first `period` values
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(e);
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export type MacdSnapshot = {
  macd: number;
  signal: number;
  histogram: number;
  bullish_cross: boolean; // MACD crossed above signal today
  bearish_cross: boolean;
};

export function macd(closes: number[]): MacdSnapshot | null {
  if (closes.length < 35) return null;
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  // Align tail lengths
  const tail = Math.min(ema12.length, ema26.length);
  const macdLine: number[] = [];
  for (let i = 0; i < tail; i++) {
    macdLine.push(ema12[ema12.length - tail + i] - ema26[ema26.length - tail + i]);
  }
  if (macdLine.length < 10) return null;
  const signalLine = emaSeries(macdLine, 9);
  if (signalLine.length < 2) return null;
  const m = macdLine[macdLine.length - 1];
  const s = signalLine[signalLine.length - 1];
  const mPrev = macdLine[macdLine.length - 2];
  const sPrev = signalLine[signalLine.length - 2];
  return {
    macd: m,
    signal: s,
    histogram: m - s,
    bullish_cross: mPrev <= sPrev && m > s,
    bearish_cross: mPrev >= sPrev && m < s,
  };
}

// Bollinger Band width as a % of price (higher = expanding volatility).
export function bollingerWidth(closes: number[], period = 20, mult = 2): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + mult * sd;
  const lower = mean - mult * sd;
  if (mean <= 0) return null;
  return (upper - lower) / mean;
}

// ATR (average true range) as % of price.
export function atrPct(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trs.push(tr);
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const px = candles[candles.length - 1].close;
  return px > 0 ? atr / px : null;
}

// Average daily volume over `period` days.
export function averageDailyVolume(candles: Candle[], period = 20): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const vols = slice.map((c) => c.volume).filter((v) => v > 0);
  if (vols.length === 0) return null;
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

// Volume-weighted momentum: signed % change weighted by relative volume.
export function volumeWeightedMomentum(candles: Candle[], lookback = 10): number | null {
  if (candles.length <= lookback) return null;
  const adv = averageDailyVolume(candles.slice(0, -1), 20);
  if (!adv || adv <= 0) return null;
  let num = 0;
  let denom = 0;
  for (let i = candles.length - lookback; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev <= 0) continue;
    const ret = (candles[i].close - prev) / prev;
    const w = Math.max(0.1, candles[i].volume / adv);
    num += ret * w;
    denom += w;
  }
  return denom > 0 ? num / denom : null;
}

// Weekly SMA/RSI derived from resampled daily candles.
// Groups by ISO week (Mon–Sun) using the daily close on the last day of the week.
function weeklyCloses(candles: Candle[]): number[] {
  if (candles.length === 0) return [];
  const buckets = new Map<string, Candle>();
  for (const c of candles) {
    const d = new Date(c.date + "T00:00:00Z");
    // ISO week key: year-weekNumber
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const daysToThursday = (day + 6) % 7 - 3; // shift so Thu is 0
    const thu = new Date(d);
    thu.setUTCDate(d.getUTCDate() - daysToThursday);
    const year = thu.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil(((thu.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    const key = `${year}-W${String(week).padStart(2, "0")}`;
    const existing = buckets.get(key);
    if (!existing || existing.date < c.date) buckets.set(key, c);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, c]) => c.close);
}

export type WeeklySnapshot = {
  weekly_sma20: number | null;
  weekly_rsi14: number | null;
  weekly_trend_up: boolean; // last close > weekly SMA20
};

export function weeklySnapshot(candles: Candle[]): WeeklySnapshot | null {
  const closes = weeklyCloses(candles);
  if (closes.length < 22) return null;
  const s20 = sma(closes, 20);
  const r14 = rsi(closes, 14);
  const last = closes[closes.length - 1];
  return {
    weekly_sma20: s20,
    weekly_rsi14: r14,
    weekly_trend_up: s20 != null ? last > s20 : false,
  };
}

// Simple daily-return correlation between two aligned close arrays.
export function returnCorrelation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;
  const ar: number[] = [];
  const br: number[] = [];
  for (let i = 1; i < n; i++) {
    if (a[i - 1] > 0 && b[i - 1] > 0) {
      ar.push((a[i] - a[i - 1]) / a[i - 1]);
      br.push((b[i] - b[i - 1]) / b[i - 1]);
    }
  }
  if (ar.length < 20) return null;
  const ma = ar.reduce((x, y) => x + y, 0) / ar.length;
  const mb = br.reduce((x, y) => x + y, 0) / br.length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < ar.length; i++) {
    const da = ar[i] - ma;
    const db = br[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

export { ema };

// ---------------------------------------------------------------------------
// Stochastic oscillator (%K / %D) — entry timing.
// %K = 100 * (close - lowestLow(n)) / (highestHigh(n) - lowestLow(n))
// %D = SMA(smoothD) of the smoothed %K series. Classic settings 14/3/3.
// ---------------------------------------------------------------------------

export type StochasticSnapshot = {
  k: number; // 0..100 smoothed %K
  d: number; // 0..100 signal line
  oversold: boolean; // %K < 20
  overbought: boolean; // %K > 80
  bull_cross: boolean; // %K crossed above %D on the latest bar
  bear_cross: boolean; // %K crossed below %D on the latest bar
  /** %K crossed up from below 20 — the classic timing trigger. */
  bull_cross_from_oversold: boolean;
  rising: boolean; // %K higher than the prior bar
};

function rawStochSeries(candles: Candle[], period: number): number[] {
  const out: number[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const win = candles.slice(i - period + 1, i + 1);
    const hh = Math.max(...win.map((c) => c.high));
    const ll = Math.min(...win.map((c) => c.low));
    const range = hh - ll;
    // Flat range (halted / illiquid bar): treat as mid-range rather than NaN.
    out.push(range > 0 ? ((candles[i].close - ll) / range) * 100 : 50);
  }
  return out;
}

function smaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out.push(s / period);
  }
  return out;
}

export function stochastic(
  candles: Candle[],
  period = 14,
  smoothK = 3,
  smoothD = 3,
): StochasticSnapshot | null {
  if (candles.length < period + smoothK + smoothD) return null;
  const raw = rawStochSeries(candles, period);
  const kSeries = smaSeries(raw, smoothK);
  const dSeries = smaSeries(kSeries, smoothD);
  if (kSeries.length < 2 || dSeries.length < 2) return null;

  const k = kSeries[kSeries.length - 1];
  const kPrev = kSeries[kSeries.length - 2];
  const d = dSeries[dSeries.length - 1];
  const dPrev = dSeries[dSeries.length - 2];
  if (![k, kPrev, d, dPrev].every(Number.isFinite)) return null;

  const bullCross = kPrev <= dPrev && k > d;
  const bearCross = kPrev >= dPrev && k < d;
  return {
    k,
    d,
    oversold: k < 20,
    overbought: k > 80,
    bull_cross: bullCross,
    bear_cross: bearCross,
    bull_cross_from_oversold: bullCross && kPrev < 20,
    rising: k > kPrev,
  };
}
