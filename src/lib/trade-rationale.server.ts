// Loads the persisted decision for one instrument plus the market events and
// headlines that were live around it, and folds them into a rationale.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildTradeRationale,
  type MarketEventInput,
  type NewsInput,
  type TradeRationale,
} from "./trade-rationale";
import { priceSymbolVariants } from "./price-symbol";

function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function loadTradeRationale(
  db: SupabaseClient,
  args: { portfolioId: string; symbol: string; date?: string; lookbackDays?: number },
): Promise<TradeRationale | null> {
  const lookback = args.lookbackDays ?? 5;
  const variants = Array.from(new Set([args.symbol, ...priceSymbolVariants(args.symbol)]));

  let q = db
    .from("ai_decision_audit")
    .select(
      "symbol, action, decided_at, rationale, market_inputs, run_date, price, notional, asset_class, instrument_ccy",
    )
    .eq("portfolio_id", args.portfolioId)
    .in("symbol", variants)
    .order("decided_at", { ascending: false })
    .limit(1);
  if (args.date) q = q.eq("run_date", args.date);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row) return null;

  const anchor = (row.run_date as string | null) ?? new Date().toISOString().slice(0, 10);
  const from = shiftIso(anchor, -lookback);

  const [newsRes, eventsRes, portfolioRes, holdingRes] = await Promise.all([
    db
      .from("news_cache")
      .select("id, news_date, headline, summary, source, url, sentiment, relevance_score, entities")
      .gte("news_date", from)
      .lte("news_date", anchor)
      .order("relevance_score", { ascending: false, nullsFirst: false })
      .limit(400),
    db
      .from("market_events")
      .select("id, event_date, kind, symbol, title, impact, notes")
      .gte("event_date", from)
      .lte("event_date", anchor)
      .order("event_date", { ascending: false })
      .limit(100),
    db.from("portfolios").select("risk_config, risk_level").eq("id", args.portfolioId).maybeSingle(),
    db
      .from("holdings")
      .select("symbol, avg_cost")
      .eq("portfolio_id", args.portfolioId)
      .in("symbol", variants)
      .limit(1),
  ]);

  const riskConfig = resolveRiskConfig(
    portfolioRes.data?.risk_config,
    portfolioRes.data?.risk_level ?? null,
  );

  return buildTradeRationale({
    decision: {
      symbol: row.symbol as string,
      action: row.action as string | null,
      decidedAt: row.decided_at as string | null,
      rationale: row.rationale as string | null,
      marketInputs: row.market_inputs,
      price: (row as { price?: number | null }).price ?? null,
      notional: (row as { notional?: number | null }).notional ?? null,
      assetClass: (row as { asset_class?: string | null }).asset_class ?? null,
      currency: (row as { instrument_ccy?: string | null }).instrument_ccy ?? null,
      avgCost: (holdingRes.data?.[0] as { avg_cost?: number | null } | undefined)?.avg_cost ?? null,
    },
    news: (newsRes.data ?? []) as unknown as NewsInput[],
    events: (eventsRes.data ?? []) as unknown as MarketEventInput[],
    riskConfig,
  });
}
