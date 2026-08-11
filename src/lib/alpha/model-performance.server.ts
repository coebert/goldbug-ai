// Phase 3 item 11 (measurement half) — realised performance per alpha model.
//
// Mirrors signal-decay.server.ts, but keyed on the *live* alpha taxonomy
// (trend / mean_reversion / quality / carry / breakout) instead of the old
// signal names. For each trade we look up the alpha scores persisted with
// that day's decision, attribute the realised 5-day edge across models in
// proportion to |score| share, and roll it into a rolling window.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPriceOn } from "../market-data.server";
import type { AlphaModelKind } from "./types";

const KINDS: AlphaModelKind[] = ["trend", "mean_reversion", "quality", "carry", "breakout"];

const WINDOW_DAYS = 30;
const HORIZON_DAYS = 5;

export type AlphaModelPerformanceRow = {
  portfolio_id: string;
  model_kind: AlphaModelKind;
  window_days: number;
  samples: number;
  hits: number;
  hit_rate: number | null;
  avg_edge_bps: number | null;
  as_of: string;
};

type PersistedAlphaScore = {
  symbol?: string;
  perModel?: Partial<Record<AlphaModelKind, number>>;
};

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function updateAlphaModelPerformance(
  portfolioId: string,
  asOf: string,
): Promise<AlphaModelPerformanceRow[]> {
  const since = addDays(asOf, -WINDOW_DAYS - HORIZON_DAYS);

  const [{ data: trades }, { data: decisions }] = await Promise.all([
    supabaseAdmin
      .from("trades")
      .select("symbol, side, price, trade_date")
      .eq("portfolio_id", portfolioId)
      .gte("trade_date", since)
      .lte("trade_date", asOf),
    supabaseAdmin
      .from("decisions")
      .select("run_date, raw")
      .eq("portfolio_id", portfolioId)
      .gte("run_date", since)
      .lte("run_date", asOf),
  ]);

  // (date|SYMBOL) -> normalised |score| share per model
  const sharesByKey = new Map<string, Record<AlphaModelKind, number>>();
  for (const d of decisions ?? []) {
    const scores = ((d.raw as { alpha_scores?: PersistedAlphaScore[] })?.alpha_scores) ?? [];
    for (const s of scores) {
      if (!s?.symbol || !s.perModel) continue;
      let total = 0;
      for (const k of KINDS) total += Math.abs(Number(s.perModel[k] ?? 0));
      if (total <= 0) continue;
      const acc = { trend: 0, mean_reversion: 0, quality: 0, carry: 0, breakout: 0 } as Record<AlphaModelKind, number>;
      for (const k of KINDS) acc[k] = Math.abs(Number(s.perModel[k] ?? 0)) / total;
      sharesByKey.set(`${d.run_date}|${s.symbol.toUpperCase()}`, acc);
    }
  }

  const agg: Record<AlphaModelKind, { samples: number; hits: number; edgeSum: number }> = {
    trend: { samples: 0, hits: 0, edgeSum: 0 },
    mean_reversion: { samples: 0, hits: 0, edgeSum: 0 },
    quality: { samples: 0, hits: 0, edgeSum: 0 },
    carry: { samples: 0, hits: 0, edgeSum: 0 },
    breakout: { samples: 0, hits: 0, edgeSum: 0 },
  };

  const cutoff = addDays(asOf, -HORIZON_DAYS);
  for (const t of trades ?? []) {
    const tradeDate = String(t.trade_date);
    if (tradeDate > cutoff) continue;
    const shares = sharesByKey.get(`${tradeDate}|${String(t.symbol).toUpperCase()}`);
    if (!shares) continue;
    const entry = Number(t.price);
    if (!(entry > 0)) continue;
    let futurePrice: number | null = null;
    try {
      futurePrice = await getPriceOn(String(t.symbol), addDays(tradeDate, HORIZON_DAYS));
    } catch {
      futurePrice = null;
    }
    if (!futurePrice) continue;
    const raw = (futurePrice - entry) / entry;
    const edge = t.side === "sell" ? -raw : raw;
    const hit = edge > 0 ? 1 : 0;
    for (const k of KINDS) {
      const share = shares[k];
      if (share <= 0.05) continue;
      agg[k].samples += 1;
      agg[k].hits += hit;
      agg[k].edgeSum += edge * 10_000 * share;
    }
  }

  const rows: AlphaModelPerformanceRow[] = KINDS.map((k) => {
    const a = agg[k];
    return {
      portfolio_id: portfolioId,
      model_kind: k,
      window_days: WINDOW_DAYS,
      samples: a.samples,
      hits: a.hits,
      hit_rate: a.samples > 0 ? a.hits / a.samples : null,
      avg_edge_bps: a.samples > 0 ? a.edgeSum / a.samples : null,
      as_of: asOf,
    };
  });

  await supabaseAdmin
    .from("alpha_model_performance" as never)
    .upsert(rows as never, { onConflict: "portfolio_id,model_kind,window_days" } as never);

  return rows;
}
