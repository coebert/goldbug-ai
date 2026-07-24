// Track per-signal decay. For each portfolio, compute rolling 30-day hit rate
// and average edge (bps) for each signal by looking at past decisions and the
// realised return of the trade over the next 5 trading days.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPriceOn } from "./market-data.server";
import { SIGNAL_KEYS, type SignalKey } from "./attribution.server";

export type SignalDecayRow = {
  portfolio_id: string;
  signal_name: SignalKey;
  window_days: number;
  samples: number;
  hits: number;
  hit_rate: number | null;
  avg_edge_bps: number | null;
  weight_avg: number | null;
  as_of: string;
};

const WINDOW_DAYS = 30;
const HORIZON_DAYS = 5;

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function updateSignalPerformance(portfolioId: string, asOf: string): Promise<SignalDecayRow[]> {
  const since = addDays(asOf, -WINDOW_DAYS - HORIZON_DAYS);
  const { data: trades } = await supabaseAdmin
    .from("trades")
    .select("symbol, side, price, trade_date")
    .eq("portfolio_id", portfolioId)
    .gte("trade_date", since)
    .lte("trade_date", asOf);
  const { data: decisions } = await supabaseAdmin
    .from("decisions")
    .select("run_date, raw")
    .eq("portfolio_id", portfolioId)
    .gte("run_date", since)
    .lte("run_date", asOf);

  // Map decision.raw.orders => weights per (date,symbol,side)
  const weightsByKey = new Map<string, Record<SignalKey, number>>();
  for (const d of decisions ?? []) {
    const orders = ((d.raw as { orders?: Array<{ symbol: string; side: string; signal_weights?: Partial<Record<SignalKey, number>> }> })?.orders) ?? [];
    for (const o of orders) {
      if (!o.signal_weights) continue;
      const acc: Record<SignalKey, number> = { sma_trend: 0, rsi: 0, price_change: 0, news_sentiment: 0, volatility: 0 };
      let s = 0;
      for (const k of SIGNAL_KEYS) s += Math.max(0, Number(o.signal_weights[k] ?? 0));
      if (s <= 0) continue;
      for (const k of SIGNAL_KEYS) acc[k] = (Math.max(0, Number(o.signal_weights[k] ?? 0)) / s) * 100;
      weightsByKey.set(`${d.run_date}|${o.symbol.toUpperCase()}|${o.side}`, acc);
    }
  }

  const perSignal: Record<SignalKey, { samples: number; hits: number; edgeSum: number; weightSum: number }> = {
    sma_trend: { samples: 0, hits: 0, edgeSum: 0, weightSum: 0 },
    rsi: { samples: 0, hits: 0, edgeSum: 0, weightSum: 0 },
    price_change: { samples: 0, hits: 0, edgeSum: 0, weightSum: 0 },
    news_sentiment: { samples: 0, hits: 0, edgeSum: 0, weightSum: 0 },
    volatility: { samples: 0, hits: 0, edgeSum: 0, weightSum: 0 },
  };

  const cutoff = addDays(asOf, -HORIZON_DAYS);
  for (const t of trades ?? []) {
    if (t.trade_date > cutoff) continue;
    const future = addDays(t.trade_date as string, HORIZON_DAYS);
    let futurePrice: number | null = null;
    try { futurePrice = await getPriceOn(t.symbol as string, future); } catch { futurePrice = null; }
    if (!futurePrice || Number(t.price) <= 0) continue;
    const raw = (futurePrice - Number(t.price)) / Number(t.price);
    const edge = t.side === "sell" ? -raw : raw; // sells profit when price falls
    const hit = edge > 0 ? 1 : 0;
    const weights = weightsByKey.get(`${t.trade_date}|${(t.symbol as string).toUpperCase()}|${t.side}`);
    if (!weights) continue;
    for (const k of SIGNAL_KEYS) {
      const w = weights[k] / 100; // 0..1
      if (w <= 0.05) continue;
      perSignal[k].samples += 1;
      perSignal[k].hits += hit;
      perSignal[k].edgeSum += edge * 10_000 * w; // bps weighted by attribution
      perSignal[k].weightSum += weights[k];
    }
  }

  const rows: SignalDecayRow[] = SIGNAL_KEYS.map((k) => {
    const p = perSignal[k];
    return {
      portfolio_id: portfolioId,
      signal_name: k,
      window_days: WINDOW_DAYS,
      samples: p.samples,
      hits: p.hits,
      hit_rate: p.samples > 0 ? p.hits / p.samples : null,
      avg_edge_bps: p.samples > 0 ? p.edgeSum / p.samples : null,
      weight_avg: p.samples > 0 ? p.weightSum / p.samples : null,
      as_of: asOf,
    };
  });

  // Upsert
  const persist = rows.map((r) => ({
    portfolio_id: r.portfolio_id,
    signal_name: r.signal_name,
    window_days: r.window_days,
    samples: r.samples,
    hits: r.hits,
    hit_rate: r.hit_rate,
    avg_edge_bps: r.avg_edge_bps,
    weight_avg: r.weight_avg,
    as_of: r.as_of,
  }));
  await supabaseAdmin
    .from("signal_performance")
    .upsert(persist, { onConflict: "portfolio_id,signal_name,window_days" });

  return rows;
}
