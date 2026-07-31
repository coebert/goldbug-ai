// Server driver for ticker watches: pull fresh candles, compute metrics, fire
// deduped alerts. Runs from the hourly cron hook so a dip is monitored between
// trading ticks even when no portfolio is trading.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  dailyVolatility,
  getDailyCandles,
  pctChange,
  refreshLatestCandles,
  rsi,
  sma,
} from "@/lib/market-data.server";
import {
  evaluateTickerWatch,
  type TickerMetrics,
  type TickerWatchConfig,
} from "@/lib/ticker-watch";

export type WatchRow = {
  id: string;
  user_id: string;
  symbol: string;
  label: string | null;
  thesis: string | null;
  buy_above: number | string | null;
  oversold_rsi: number | string;
  max_vol_pct: number | string;
  drop_below: number | string | null;
  active: boolean;
};

export function toConfig(row: WatchRow): TickerWatchConfig {
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    symbol: row.symbol,
    buyAbove: row.buy_above == null ? null : num(row.buy_above),
    oversoldRsi: num(row.oversold_rsi) ?? 30,
    maxVolPct: num(row.max_vol_pct) ?? 30,
    dropBelow: row.drop_below == null ? null : num(row.drop_below),
  };
}

/** Latest metrics for a symbol, from cached candles (refreshed first). */
export async function loadTickerMetrics(symbol: string): Promise<TickerMetrics | null> {
  const candles = await getDailyCandles(symbol, 90);
  const closes = candles.map((c) => Number(c.close)).filter((n) => Number.isFinite(n) && n > 0);
  if (closes.length < 2) return null;
  const vol = dailyVolatility(closes, 20);
  const window = closes.slice(-21, -1);
  return {
    price: closes[closes.length - 1],
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, 14),
    annualVolPct: vol == null ? null : vol * Math.sqrt(252) * 100,
    changePct1d: (pctChange(closes, 1) ?? 0) * 100,
    changePct5d: closes.length > 5 ? (pctChange(closes, 5) ?? 0) * 100 : null,
    priorLow: window.length > 0 ? Math.min(...window) : null,
  };
}

export type TickerWatchScanResult = {
  watches: number;
  evaluated: number;
  fired: number;
  suppressed: number;
  errors: string[];
};

export async function runTickerWatchScan(): Promise<TickerWatchScanResult> {
  const result: TickerWatchScanResult = {
    watches: 0,
    evaluated: 0,
    fired: 0,
    suppressed: 0,
    errors: [],
  };

  const { data: rows, error } = await supabaseAdmin
    .from("ticker_watches")
    .select("id, user_id, symbol, label, thesis, buy_above, oversold_rsi, max_vol_pct, drop_below, active")
    .eq("active", true);
  if (error) {
    result.errors.push(`ticker_watches read failed: ${error.message}`);
    return result;
  }
  const watches = (rows ?? []) as WatchRow[];
  result.watches = watches.length;
  if (watches.length === 0) return result;

  // Keep today's bar current — a dip alert on yesterday's close is useless.
  try {
    await refreshLatestCandles([...new Set(watches.map((w) => w.symbol))]);
  } catch (e) {
    result.errors.push(`price refresh failed: ${(e as Error).message}`);
  }

  const { sendPushToUser } = await import("@/lib/push.server");
  const today = new Date().toISOString().slice(0, 10);

  for (const row of watches) {
    let metrics: TickerMetrics | null = null;
    try {
      metrics = await loadTickerMetrics(row.symbol);
    } catch (e) {
      result.errors.push(`${row.symbol}: ${(e as Error).message}`);
      continue;
    }
    if (!metrics) {
      result.errors.push(`${row.symbol}: no price history`);
      continue;
    }
    result.evaluated += 1;

    for (const trigger of evaluateTickerWatch(toConfig(row), metrics)) {
      // Unique (watch, trigger, day) — a condition that stays true all day
      // notifies once, so the inbox stays readable.
      const claim = await supabaseAdmin.from("ticker_watch_alerts").insert({
        watch_id: row.id,
        user_id: row.user_id,
        symbol: row.symbol,
        trigger_code: trigger.code,
        alert_date: today,
        price: metrics.price,
        details: {
          rsi14: metrics.rsi14,
          annualVolPct: metrics.annualVolPct,
          sma20: metrics.sma20,
          sma50: metrics.sma50,
          changePct5d: metrics.changePct5d,
        },
      });
      if (claim.error) {
        result.suppressed += 1; // unique violation = already alerted today
        continue;
      }

      await supabaseAdmin.from("notifications").insert({
        user_id: row.user_id,
        category: "ticker_watch",
        severity: trigger.severity,
        title: trigger.title,
        body: trigger.body,
        details: { symbol: row.symbol, trigger: trigger.code, price: metrics.price },
      });
      try {
        await sendPushToUser(row.user_id, {
          title: trigger.title,
          body: trigger.body,
          url: "/",
          tag: `ticker-watch-${row.symbol}-${trigger.code}`,
        });
      } catch (e) {
        result.errors.push(`push ${row.symbol}: ${(e as Error).message}`);
      }
      result.fired += 1;
    }
  }

  return result;
}
