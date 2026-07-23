// Attribution dashboard — breaks each executed trade's outcome into
// per-signal contribution, news_score impact, and regime/event penalties.
// Server-only (uses supabaseAdmin + price cache).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPriceOn } from "./market-data.server";
import { computeAttribution, SIGNAL_KEYS, type SignalKey, type AttributionReport } from "./attribution.server";

export type TradePoint = {
  trade_date: string;
  symbol: string;
  side: "buy" | "sell";
  fill_price: number;
  exit_price: number | null;
  forward_return_pct: number | null; // signed vs side
  benchmark_return_pct: number | null; // SPY return over the same window (unsigned; long-only benchmark)
  alpha_pct: number | null; // forward_return_pct - benchmark_return_pct
  news_score: number | null;
  regime: string | null;
  event_penalty: number; // 1.0 = none, <1 = penalty applied at execution
  cooldown_applied: boolean;
  liquidity_capped: boolean;
  signal_weights: Record<SignalKey, number>;
  signal_contrib: Record<SignalKey, number>; // return_pct * weight fraction
};


export type NewsBucket = {
  bucket: string; // e.g. "-1..-0.5"
  n: number;
  avg_return_pct: number | null;
  win_rate: number | null;
};

export type RegimeBreakdown = {
  regime: string;
  n: number;
  avg_return_pct: number | null;
  win_rate: number | null;
};

export type PenaltyBreakdown = {
  bucket: "none" | "event_low" | "event_med" | "event_high" | "cooldown" | "liquidity";
  n: number;
  avg_return_pct: number | null;
  win_rate: number | null;
};

export type AttributionDashboard = {
  window_days: number;
  horizon_days: number;
  overall: AttributionReport;
  trades: TradePoint[];
  cumulative_by_signal: Array<{ trade_date: string } & Record<SignalKey, number>>;
  cumulative_alpha: Array<{ trade_date: string; strategy: number; benchmark: number; alpha: number }>;
  alpha_summary: {
    n: number;
    avg_return_pct: number | null;
    avg_benchmark_pct: number | null;
    avg_alpha_pct: number | null;
    alpha_win_rate: number | null; // share of trades where alpha > 0
    hit_rate: number | null; // share where forward return > 0
  };
  news_buckets: NewsBucket[];
  regime_breakdown: RegimeBreakdown[];
  penalty_breakdown: PenaltyBreakdown[];
};


// Parse the executed.reason string for event x0.75 / cooldown x0.5 / liquidity flags.
function parsePenalty(reason: string): { event: number; cooldown: boolean; liquidity: boolean } {
  const evMatch = reason.match(/event\s*x([0-9.]+)/i);
  const event = evMatch ? Math.max(0, Math.min(1, Number(evMatch[1]))) : 1;
  const cooldown = /cooldown\s*x/i.test(reason);
  const liquidity = /liquidity\s*1%\s*ADV/i.test(reason);
  return { event, cooldown, liquidity };
}

function eventBucket(p: number): PenaltyBreakdown["bucket"] {
  if (p >= 0.99) return "none";
  if (p >= 0.85) return "event_low";
  if (p >= 0.7) return "event_med";
  return "event_high";
}

function newsBucketLabel(s: number | null): string {
  if (s == null) return "n/a";
  if (s <= -0.5) return "very bearish (≤-0.5)";
  if (s < -0.1) return "bearish (-0.5..-0.1)";
  if (s <= 0.1) return "neutral (-0.1..0.1)";
  if (s < 0.5) return "bullish (0.1..0.5)";
  return "very bullish (≥0.5)";
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function winRate(xs: number[]): number | null {
  return xs.length ? xs.filter((r) => r >= 0).length / xs.length : null;
}

export async function getAttributionDashboard(
  portfolioId: string,
  asOf: string,
  windowDays = 90,
  horizonDays = 5,
): Promise<AttributionDashboard> {
  const overall = await computeAttribution(portfolioId, asOf, windowDays, horizonDays);

  const since = new Date(asOf);
  since.setDate(since.getDate() - windowDays);
  const sinceStr = since.toISOString().slice(0, 10);

  const { data: decisions } = await supabaseAdmin
    .from("decisions")
    .select("run_date, raw")
    .eq("portfolio_id", portfolioId)
    .gte("run_date", sinceStr)
    .lte("run_date", asOf)
    .order("run_date", { ascending: true });

  const trades: TradePoint[] = [];

  for (const d of decisions ?? []) {
    const raw = d.raw as unknown;
    if (!raw || typeof raw !== "object") continue;
    const orders = (raw as { orders?: Array<{ symbol?: string; side?: "buy" | "sell"; signal_weights?: Partial<Record<SignalKey, number>> }> }).orders ?? [];
    const executed = (raw as { executed?: Array<{ symbol: string; side: string; quantity: number; price: number; reason?: string; rejected?: string }> }).executed ?? [];
    const signals = (raw as { signals?: Array<{ symbol: string; news_score: number | null }> }).signals ?? [];
    const regime = (raw as { regime?: { regime?: string } | null }).regime;

    const newsBySym = new Map(signals.map((s) => [s.symbol.toUpperCase(), s.news_score] as const));
    const weightsByKey = new Map<string, Partial<Record<SignalKey, number>>>();
    for (const o of orders) {
      if (o.symbol && o.side && o.signal_weights) {
        weightsByKey.set(`${o.symbol.toUpperCase()}:${o.side}`, o.signal_weights);
      }
    }

    for (const ex of executed) {
      if (ex.rejected || !(ex.quantity > 0)) continue;
      if (ex.side !== "buy" && ex.side !== "sell") continue;
      const key = `${ex.symbol.toUpperCase()}:${ex.side}`;
      const w = weightsByKey.get(key);
      const totalW = w
        ? SIGNAL_KEYS.reduce((a, k) => a + Math.max(0, Number(w[k] ?? 0)), 0)
        : 0;
      const weightFractions: Record<SignalKey, number> = {
        sma_trend: 0, rsi: 0, price_change: 0, news_sentiment: 0, volatility: 0,
      };
      if (w && totalW > 0) {
        for (const k of SIGNAL_KEYS) weightFractions[k] = Math.max(0, Number(w[k] ?? 0)) / totalW;
      }

      // Forward return
      const tradeDate = d.run_date as string;
      const target = new Date(tradeDate);
      target.setDate(target.getDate() + horizonDays);
      const exitDate = target > new Date(asOf) ? asOf : target.toISOString().slice(0, 10);
      const exit = await getPriceOn(ex.symbol, exitDate).catch(() => null);
      let signedPct: number | null = null;
      if (exit != null && exit > 0 && ex.price > 0) {
        const r = (exit - ex.price) / ex.price;
        signedPct = (ex.side === "buy" ? r : -r) * 100;
      }

      // Benchmark (SPY) return over the same [tradeDate, exitDate] window.
      // Benchmark is long-only: we do NOT flip the sign for shorts — alpha
      // for a short is measured against being long the market.
      const [spyEntry, spyExit] = await Promise.all([
        getPriceOn("SPY", tradeDate).catch(() => null),
        getPriceOn("SPY", exitDate).catch(() => null),
      ]);
      let benchPct: number | null = null;
      if (spyEntry != null && spyExit != null && spyEntry > 0) {
        benchPct = ((spyExit - spyEntry) / spyEntry) * 100;
      }
      const alphaPct = signedPct != null && benchPct != null ? signedPct - benchPct : null;

      const pen = parsePenalty(ex.reason ?? "");
      const signalContrib: Record<SignalKey, number> = {
        sma_trend: 0, rsi: 0, price_change: 0, news_sentiment: 0, volatility: 0,
      };
      if (signedPct != null) {
        for (const k of SIGNAL_KEYS) signalContrib[k] = weightFractions[k] * signedPct;
      }

      trades.push({
        trade_date: tradeDate,
        symbol: ex.symbol,
        side: ex.side,
        fill_price: ex.price,
        exit_price: exit,
        forward_return_pct: signedPct,
        benchmark_return_pct: benchPct,
        alpha_pct: alphaPct,
        news_score: newsBySym.get(ex.symbol.toUpperCase()) ?? null,
        regime: regime?.regime ?? null,
        event_penalty: pen.event,
        cooldown_applied: pen.cooldown,
        liquidity_capped: pen.liquidity,
        signal_weights: {
          sma_trend: Number(w?.sma_trend ?? 0),
          rsi: Number(w?.rsi ?? 0),
          price_change: Number(w?.price_change ?? 0),
          news_sentiment: Number(w?.news_sentiment ?? 0),
          volatility: Number(w?.volatility ?? 0),
        },
        signal_contrib: signalContrib,
      });
    }
  }


  // Cumulative-by-signal time series (bucket per trade_date)
  const byDate = new Map<string, Record<SignalKey, number>>();
  for (const t of trades) {
    if (t.forward_return_pct == null) continue;
    const cur = byDate.get(t.trade_date) ?? { sma_trend: 0, rsi: 0, price_change: 0, news_sentiment: 0, volatility: 0 };
    for (const k of SIGNAL_KEYS) cur[k] += t.signal_contrib[k];
    byDate.set(t.trade_date, cur);
  }
  const dates = Array.from(byDate.keys()).sort();
  const cum: Record<SignalKey, number> = { sma_trend: 0, rsi: 0, price_change: 0, news_sentiment: 0, volatility: 0 };
  const cumulative_by_signal = dates.map((date) => {
    const day = byDate.get(date)!;
    for (const k of SIGNAL_KEYS) cum[k] += day[k];
    return { trade_date: date, ...cum } as { trade_date: string } & Record<SignalKey, number>;
  });

  // News buckets
  const newsGroups = new Map<string, number[]>();
  for (const t of trades) {
    if (t.forward_return_pct == null) continue;
    const b = newsBucketLabel(t.news_score);
    if (!newsGroups.has(b)) newsGroups.set(b, []);
    newsGroups.get(b)!.push(t.forward_return_pct);
  }
  const news_buckets: NewsBucket[] = ["very bearish (≤-0.5)", "bearish (-0.5..-0.1)", "neutral (-0.1..0.1)", "bullish (0.1..0.5)", "very bullish (≥0.5)", "n/a"]
    .map((b) => {
      const xs = newsGroups.get(b) ?? [];
      return { bucket: b, n: xs.length, avg_return_pct: mean(xs), win_rate: winRate(xs) };
    })
    .filter((r) => r.n > 0);

  // Regime breakdown
  const regGroups = new Map<string, number[]>();
  for (const t of trades) {
    if (t.forward_return_pct == null) continue;
    const r = t.regime ?? "unknown";
    if (!regGroups.has(r)) regGroups.set(r, []);
    regGroups.get(r)!.push(t.forward_return_pct);
  }
  const regime_breakdown: RegimeBreakdown[] = Array.from(regGroups.entries())
    .map(([regime, xs]) => ({ regime, n: xs.length, avg_return_pct: mean(xs), win_rate: winRate(xs) }))
    .sort((a, b) => b.n - a.n);

  // Penalty breakdown
  const penGroups = new Map<PenaltyBreakdown["bucket"], number[]>();
  for (const t of trades) {
    if (t.forward_return_pct == null) continue;
    // A trade may be tagged with multiple; prefer the strongest signal.
    const buckets: PenaltyBreakdown["bucket"][] = [];
    if (t.event_penalty < 0.99) buckets.push(eventBucket(t.event_penalty));
    if (t.cooldown_applied) buckets.push("cooldown");
    if (t.liquidity_capped) buckets.push("liquidity");
    if (buckets.length === 0) buckets.push("none");
    for (const b of buckets) {
      if (!penGroups.has(b)) penGroups.set(b, []);
      penGroups.get(b)!.push(t.forward_return_pct);
    }
  }
  const penalty_breakdown: PenaltyBreakdown[] = (["none", "event_low", "event_med", "event_high", "cooldown", "liquidity"] as const)
    .map((b) => {
      const xs = penGroups.get(b) ?? [];
      return { bucket: b, n: xs.length, avg_return_pct: mean(xs), win_rate: winRate(xs) };
    })
    .filter((r) => r.n > 0);

  return {
    window_days: windowDays,
    horizon_days: horizonDays,
    overall,
    trades: trades.sort((a, b) => b.trade_date.localeCompare(a.trade_date)),
    cumulative_by_signal,
    news_buckets,
    regime_breakdown,
    penalty_breakdown,
  };
}
