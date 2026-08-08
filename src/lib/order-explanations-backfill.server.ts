// Backfill of plain-English "why this trade" explanations for historical
// decisions.
//
// Explanations are normally generated lazily the first time an order panel is
// rendered, and cached in `order_explanations`. Decisions made before that
// feature existed therefore have no stored explanation. This module walks the
// caller's decision history, rebuilds the SAME `ExplainOrderInput` the UI
// would send (so the cache key matches and the UI serves the backfilled row
// for free), and generates anything missing in bounded batches.

import { keywordMatch } from "@/components/portfolio-detail/format";
import type { DecisionRaw, ExecutedRow, SignalWeights } from "@/components/portfolio-detail/types";
import { parseTradingStyle, type TradingStyle } from "./trading-style";
import { runExplainOrder, type ExplainOrderInput } from "./order-explanations.server";

export type BackfillDb = { from: (table: string) => any };

export type BackfillStatus = {
  totalOrders: number;
  explained: number;
  missing: number;
};

export type BackfillResult = BackfillStatus & {
  generated: number;
  failed: number;
  errors: string[];
};

type DecisionRow = {
  id: string;
  portfolio_id: string;
  run_date: string;
  raw: unknown;
  portfolios?: { currency?: string | null; risk_config?: unknown } | null;
};

type PendingOrder = { decisionId: string; orderKey: string; input: ExplainOrderInput };

function weightsFor(raw: DecisionRaw, order: ExecutedRow): SignalWeights | null {
  const key = `${order.symbol.toUpperCase()}:${order.side}`;
  for (const o of raw.orders ?? []) {
    if (!o?.symbol || !o?.side) continue;
    if (`${o.symbol.toUpperCase()}:${o.side}` !== key) continue;
    const w = o.signal_weights;
    if (!w) return null;
    return {
      sma_trend: Number(w.sma_trend ?? 0),
      rsi: Number(w.rsi ?? 0),
      price_change: Number(w.price_change ?? 0),
      news_sentiment: Number(w.news_sentiment ?? 0),
      volatility: Number(w.volatility ?? 0),
    };
  }
  return null;
}

function styleOf(riskConfig: unknown): TradingStyle {
  return parseTradingStyle((riskConfig as { trading_style?: unknown } | null)?.trading_style);
}

/** Rebuild every explainable order for a decision, in UI order/indexing. */
export function ordersForDecision(row: DecisionRow): PendingOrder[] {
  const raw = (row.raw ?? {}) as DecisionRaw;
  const executed = raw.executed ?? [];
  const signals = raw.signals ?? [];
  const news = raw.news ?? [];
  const currency = row.portfolios?.currency ?? "GBP";
  const tradingStyle = styleOf(row.portfolios?.risk_config ?? null);

  const out: PendingOrder[] = [];
  executed.forEach((order, orderIndex) => {
    if (!order?.symbol || !order?.side) return;
    const orderKey = `${order.symbol.toUpperCase()}:${order.side}:${orderIndex}`;
    const signal = signals.find((s) => s.symbol?.toUpperCase() === order.symbol.toUpperCase());
    const relatedNews = signal
      ? news.filter((n) => keywordMatch(n.headline, signal.symbol, signal.name)).slice(0, 3)
      : [];
    out.push({
      decisionId: row.id,
      orderKey,
      input: {
        decisionId: row.id,
        orderKey,
        symbol: order.symbol,
        side: order.side,
        reason: order.reason ?? "",
        rejected: order.rejected ?? null,
        quantity: Number(order.quantity ?? 0),
        price: Number(order.price ?? 0),
        value: Number(order.value ?? 0),
        currency,
        weights: weightsFor(raw, order),
        tradingStyle,
        relatedNews: relatedNews.map((n) => ({ headline: n.headline, source: n.source ?? null })),
        guardrails: raw.guardrails
          ? {
              risk_level: raw.guardrails.risk_level,
              max_position_pct: raw.guardrails.max_position_pct,
              cash_floor_pct: raw.guardrails.cash_floor_pct,
            }
          : null,
      },
    });
  });
  return out;
}

async function loadDecisions(db: BackfillDb, portfolioId?: string): Promise<DecisionRow[]> {
  let q = db
    .from("decisions")
    .select("id, portfolio_id, run_date, raw, portfolios(currency, risk_config)")
    .order("run_date", { ascending: false })
    .limit(2000);
  if (portfolioId) q = q.eq("portfolio_id", portfolioId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as DecisionRow[];
}

async function loadExplained(db: BackfillDb, decisionIds: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let i = 0; i < decisionIds.length; i += 200) {
    const chunk = decisionIds.slice(i, i + 200);
    const { data, error } = await db
      .from("order_explanations")
      .select("decision_id, order_key")
      .in("decision_id", chunk);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) seen.add(`${r.decision_id}|${r.order_key}`);
  }
  return seen;
}

async function collectPending(db: BackfillDb, portfolioId?: string) {
  const decisions = await loadDecisions(db, portfolioId);
  const all = decisions.flatMap(ordersForDecision);
  const explained = await loadExplained(db, [...new Set(all.map((o) => o.decisionId))]);
  const pending = all.filter((o) => !explained.has(`${o.decisionId}|${o.orderKey}`));
  return { all, pending };
}

export async function getBackfillStatus(
  db: BackfillDb,
  portfolioId?: string,
): Promise<BackfillStatus> {
  const { all, pending } = await collectPending(db, portfolioId);
  return { totalOrders: all.length, explained: all.length - pending.length, missing: pending.length };
}

/**
 * Generate explanations for up to `batchSize` missing orders. Sequential on
 * purpose: the gateway is rate-limited and a backfill is not latency-critical.
 * Callers loop until `missing` reaches zero.
 */
export async function runBackfillBatch(
  db: BackfillDb,
  opts: { portfolioId?: string; batchSize: number },
): Promise<BackfillResult> {
  const { all, pending } = await collectPending(db, opts.portfolioId);
  const batch = pending.slice(0, opts.batchSize);

  let generated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const item of batch) {
    try {
      await runExplainOrder(item.input, db);
      generated += 1;
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (errors.length < 5) errors.push(`${item.input.symbol}: ${msg}`);
      // Rate limit / credit exhaustion: stop early rather than burn the batch.
      if (/429|402|rate limit|credit/i.test(msg)) break;
    }
  }

  return {
    totalOrders: all.length,
    explained: all.length - pending.length + generated,
    missing: Math.max(0, pending.length - generated),
    generated,
    failed,
    errors,
  };
}
