// Yahoo Finance daily OHLCV fetcher with DB caching.
// Uses the public chart endpoint — no key required.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type Candle = {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function toISODate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

async function fetchYahooDaily(symbol: string, days: number): Promise<Candle[]> {
  // range picks: buffer to ensure we get `days` trading days back
  const range = days <= 30 ? "3mo" : days <= 180 ? "1y" : days <= 365 ? "2y" : "5y";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?interval=1d&range=${range}`;
  const { runWithBreaker } = await import("@/lib/_server/provider-circuit");
  const res = await runWithBreaker("yahoo", () =>
    fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LovableTrader/1.0)" },
    }).then((r) => {
      // Treat retryable/upstream failures as breaker faults so a Yahoo outage
      // trips fast instead of burning the request budget on repeated timeouts.
      if (!r.ok && (r.status >= 500 || r.status === 429)) {
        throw new Error(`Yahoo transient ${r.status} for ${symbol}`);
      }
      return r;
    }));
  if (!res.ok) {
    throw new Error(`Yahoo fetch failed for ${symbol}: ${res.status}`);
  }
  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            close?: (number | null)[];
            volume?: (number | null)[];
          }>;
        };
      }>;
      error?: { description?: string } | null;
    };
  };
  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp) {
    throw new Error(`Yahoo returned no data for ${symbol}`);
  }
  const q = result.indicators?.quote?.[0];
  if (!q) throw new Error(`Yahoo returned no quotes for ${symbol}`);
  const out: Candle[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = q.close?.[i];
    if (close == null) continue;
    out.push({
      date: toISODate(result.timestamp[i]),
      open: q.open?.[i] ?? close,
      high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close,
      close,
      volume: q.volume?.[i] ?? 0,
    });
  }
  return out;
}

/**
 * Get up to `days` daily candles ending on or before `asOf` for `symbol`.
 * Uses cache; refetches from Yahoo when cache is missing / stale.
 */
export async function getDailyCandles(
  symbol: string,
  days: number,
  asOf?: string,
): Promise<Candle[]> {
  const asOfDate = asOf ?? new Date().toISOString().slice(0, 10);

  // First try cache
  const { data: cached } = await supabaseAdmin
    .from("price_cache")
    .select("price_date, open, high, low, close, volume")
    .eq("symbol", symbol)
    .lte("price_date", asOfDate)
    .order("price_date", { ascending: false })
    .limit(days);

  const cachedCandles: Candle[] = (cached ?? [])
    .map((r) => ({
      date: r.price_date as string,
      open: Number(r.open ?? r.close),
      high: Number(r.high ?? r.close),
      low: Number(r.low ?? r.close),
      close: Number(r.close),
      volume: Number(r.volume ?? 0),
    }))
    .reverse();

  // If we have enough recent data (last row within a few days of asOf), use cache
  if (cachedCandles.length >= Math.min(days, 20)) {
    const lastDate = cachedCandles[cachedCandles.length - 1].date;
    const gapDays =
      (new Date(asOfDate).getTime() - new Date(lastDate).getTime()) / 86400000;
    if (gapDays < 5) return cachedCandles;
  }

  // Fetch fresh from Yahoo and upsert
  try {
    const fresh = await fetchYahooDaily(symbol, Math.max(days + 30, 90));
    if (fresh.length > 0) {
      const rows = fresh.map((c) => ({
        symbol,
        price_date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      // Upsert in chunks
      for (let i = 0; i < rows.length; i += 500) {
        await supabaseAdmin
          .from("price_cache")
          .upsert(rows.slice(i, i + 500), { onConflict: "symbol,price_date" });
      }
    }
    return fresh.filter((c) => c.date <= asOfDate).slice(-days);
  } catch (err) {
    console.error(`market-data: fallback to cache for ${symbol}:`, err);
    return cachedCandles;
  }
}

export async function getPriceOn(symbol: string, date: string): Promise<number | null> {
  const candles = await getDailyCandles(symbol, 5, date);
  const match = candles.filter((c) => c.date <= date).pop();
  return match?.close ?? null;
}

// Fetch a long historical window (up to Yahoo's max) and cache it.
// Returns candles between `from` and `to` inclusive (ISO YYYY-MM-DD).
export async function getDailyCandlesRange(
  symbol: string,
  from: string,
  to: string,
): Promise<Candle[]> {
  const { data: cached } = await supabaseAdmin
    .from("price_cache")
    .select("price_date, open, high, low, close, volume")
    .eq("symbol", symbol)
    .gte("price_date", from)
    .lte("price_date", to)
    .order("price_date", { ascending: true });

  const yearsSpan = Math.max(
    0.1,
    (new Date(to).getTime() - new Date(from).getTime()) / (365.25 * 86400000),
  );
  // If cache is dense (>=180 rows/yr, ~ trading days), use it.
  if ((cached?.length ?? 0) >= Math.min(180 * yearsSpan, 180)) {
    return (cached ?? []).map((r) => ({
      date: r.price_date as string,
      open: Number(r.open ?? r.close),
      high: Number(r.high ?? r.close),
      low: Number(r.low ?? r.close),
      close: Number(r.close),
      volume: Number(r.volume ?? 0),
    }));
  }

  const period1 = Math.floor(new Date(from).getTime() / 1000);
  const period2 = Math.floor(new Date(to).getTime() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?interval=1d&period1=${period1}&period2=${period2}`;
  try {
    const { runWithBreaker } = await import("@/lib/_server/provider-circuit");
    const res = await runWithBreaker("yahoo", () =>
      fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; LovableTrader/1.0)" },
      }).then((r) => {
        if (!r.ok && (r.status >= 500 || r.status === 429)) {
          throw new Error(`Yahoo transient ${r.status}`);
        }
        return r;
      }));
    if (!res.ok) throw new Error(`Yahoo ${res.status}`);
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
              volume?: (number | null)[];
            }>;
          };
        }>;
      };
    };
    const result = json.chart?.result?.[0];
    if (!result?.timestamp) return [];
    const q = result.indicators?.quote?.[0];
    if (!q) return [];
    const out: Candle[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const close = q.close?.[i];
      if (close == null) continue;
      out.push({
        date: toISODate(result.timestamp[i]),
        open: q.open?.[i] ?? close,
        high: q.high?.[i] ?? close,
        low: q.low?.[i] ?? close,
        close,
        volume: q.volume?.[i] ?? 0,
      });
    }
    if (out.length > 0) {
      const rows = out.map((c) => ({
        symbol,
        price_date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        await supabaseAdmin
          .from("price_cache")
          .upsert(rows.slice(i, i + 500), { onConflict: "symbol,price_date" });
      }
    }
    return out.filter((c) => c.date >= from && c.date <= to);
  } catch (err) {
    console.error(`getDailyCandlesRange failed for ${symbol}:`, err);
    return (cached ?? []).map((r) => ({
      date: r.price_date as string,
      open: Number(r.open ?? r.close),
      high: Number(r.high ?? r.close),
      low: Number(r.low ?? r.close),
      close: Number(r.close),
      volume: Number(r.volume ?? 0),
    }));
  }
}

// Simple technicals
export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function pctChange(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - lookback];
  if (!then) return null;
  return (now - then) / then;
}

// Daily-return standard deviation over the last `period` days.
export function dailyVolatility(closes: number[], period = 20): number | null {
  if (closes.length < period + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0) rets.push((closes[i] - prev) / prev);
  }
  if (rets.length === 0) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}


/**
 * Force a fresh Yahoo fetch and upsert of the most recent candles for each symbol.
 * Used by the hourly monitor to keep today's close current between daily bars.
 */
export async function refreshLatestCandles(symbols: string[]): Promise<{ refreshed: number; errors: number }> {
  let refreshed = 0;
  let errors = 0;
  for (const symbol of symbols) {
    try {
      const fresh = await fetchYahooDaily(symbol, 5);
      if (fresh.length === 0) continue;
      const rows = fresh.map((c) => ({
        symbol,
        price_date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      await supabaseAdmin
        .from("price_cache")
        .upsert(rows, { onConflict: "symbol,price_date" });
      refreshed++;
    } catch (err) {
      console.warn(`refreshLatestCandles: ${symbol} failed`, err);
      errors++;
    }
  }
  return { refreshed, errors };
}
