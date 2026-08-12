// Chart data loader for the SMA drill-down: guarantees that every symbol the
// user charts has enough *and* fresh daily closes, backfilling from the price
// feed (which upserts into `price_cache`) whenever the cache is short or stale.
//
// The old rule only backfilled when the cache held almost nothing, so a ticker
// with a handful of cached rows could render a 1-year chart with a blank
// 200-day average. Coverage is now judged against what the requested window
// actually needs.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDailyCandles, getDailyCandlesRange } from "./market-data.server";

export interface HistoryPriceRow {
  symbol: string;
  price_date: string;
  close: number;
}

/** Rough trading days in a calendar span (5 sessions per 7 days, minus holidays). */
export function tradingDaysFor(calendarDays: number): number {
  return Math.max(20, Math.floor(calendarDays * 0.68));
}

/** Calendar days of lookback needed to seed a 200-day average at window start. */
export const SMA_WARMUP_DAYS = 320;

function isStale(lastDate: string | undefined, todayIso: string): boolean {
  if (!lastDate) return true;
  const ms = Date.parse(todayIso) - Date.parse(lastDate);
  if (!Number.isFinite(ms)) return true;
  // Allow a long weekend / bank holiday before calling the cache stale.
  return ms > 4 * 86_400_000;
}

/**
 * Load daily closes for `symbol` covering `days` of chart plus SMA warm-up,
 * backfilling from the feed when the cache is incomplete or out of date.
 */
export async function loadHistoryRows(
  symbol: string,
  days: number,
  now = new Date(),
): Promise<HistoryPriceRow[]> {
  const todayIso = now.toISOString().slice(0, 10);
  const spanDays = days + SMA_WARMUP_DAYS;
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - spanDays);
  const sinceIso = since.toISOString().slice(0, 10);

  const { data, error } = await supabaseAdmin
    .from("price_cache")
    .select("symbol, price_date, close")
    .eq("symbol", symbol)
    .gte("price_date", sinceIso)
    .order("price_date", { ascending: true })
    .limit(4000);

  if (error) throw new Error(error.message);

  const byDate = new Map<string, number>();
  for (const r of data ?? []) {
    const close = Number(r.close);
    if (Number.isFinite(close) && close > 0) byDate.set(r.price_date as string, close);
  }

  const needed = tradingDaysFor(spanDays);
  const dates = Array.from(byDate.keys()).sort();
  // 85% of the theoretical session count is plenty: listings younger than the
  // window, or markets with extra holidays, should not trigger a fetch loop.
  const short = byDate.size < needed * 0.85;
  const stale = isStale(dates[dates.length - 1], todayIso);

  const absorb = (candles: { date: string; close: number }[]) => {
    for (const c of candles) {
      const close = Number(c.close);
      if (c.date >= sinceIso && Number.isFinite(close) && close > 0) byDate.set(c.date, close);
    }
  };

  // Depth: an explicit date range pulls the whole window from the feed (and
  // caches it), instead of the newest-N slice a day-count fetch returns.
  if (short) {
    try {
      absorb(await getDailyCandlesRange(symbol, sinceIso, todayIso));
    } catch (err) {
      console.error("symbol-history: range backfill failed", symbol, err);
    }
  }

  // Freshness: a dense but out-of-date cache still needs the latest sessions.
  if (stale || isStale(Array.from(byDate.keys()).sort().pop(), todayIso)) {
    try {
      absorb(await getDailyCandles(symbol, Math.min(needed + 40, 2000), todayIso));
    } catch (err) {
      console.error("symbol-history: recent backfill failed", symbol, err);
    }
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([price_date, close]) => ({ symbol, price_date, close }));
}
