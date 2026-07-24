// Prompt A/B harness: runs a shadow "variant B" decision alongside the primary
// AI decision each hour, logs both, and computes agreement/divergence metrics.
// Fire-and-forget from trading-engine; never affects live execution.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { DecisionOutput } from "./trading-engine.server";
import { callAiForDecision } from "./trading-engine.server";

// Variant B tilt: mean-reversion / contrarian bias to test against the
// momentum-leaning default prompt.
const VARIANT_B_SUFFIX = `You are the CONTRARIAN VARIANT (shadow / non-executing).
Override style priors:
- Favour mean-reversion: prefer BUY when RSI-14 < 30 with stable weekly trend; prefer SELL/TRIM when RSI-14 > 70.
- Discount pure trend-continuation setups unless news_momentum is clearly accelerating (+delta_3d AND +accel).
- Halve conviction on names where sma_trend weight would dominate; up-weight news_sentiment and volatility features.
- All hard rules (cash floor, per-symbol cap, no leverage, universe restriction) still apply unchanged.
- Keep orders shorter; skip if any signal disagreement is unresolved.`;

const VARIANT_NAME = "contrarian_v1";

type OrderLike = { symbol: string; side: string; percent: number; conviction: number };

function normalize(orders: unknown): OrderLike[] {
  if (!Array.isArray(orders)) return [];
  return orders
    .map((o: any) => ({
      symbol: String(o?.symbol ?? "").toUpperCase(),
      side: String(o?.side ?? "").toLowerCase(),
      percent: Number(o?.percent) || 0,
      conviction: Number(o?.conviction) || 0,
    }))
    .filter((o) => o.symbol && (o.side === "buy" || o.side === "sell"));
}

function computeAgreement(a: OrderLike[], b: OrderLike[]) {
  const map = new Map<string, OrderLike>();
  for (const o of a) map.set(`${o.symbol}:${o.side}`, o);
  const divergences: Array<{
    symbol: string;
    kind: "primary_only" | "shadow_only" | "conflicting_side" | "sizing_gap";
    primary?: OrderLike | null;
    shadow?: OrderLike | null;
  }> = [];
  const matched = new Set<string>();
  for (const s of b) {
    const key = `${s.symbol}:${s.side}`;
    const p = map.get(key);
    if (p) {
      matched.add(key);
      const gap = Math.abs(p.percent - s.percent);
      if (gap > 25) {
        divergences.push({ symbol: s.symbol, kind: "sizing_gap", primary: p, shadow: s });
      }
    } else {
      const opposite = map.get(`${s.symbol}:${s.side === "buy" ? "sell" : "buy"}`);
      if (opposite) {
        divergences.push({ symbol: s.symbol, kind: "conflicting_side", primary: opposite, shadow: s });
      } else {
        divergences.push({ symbol: s.symbol, kind: "shadow_only", primary: null, shadow: s });
      }
    }
  }
  for (const [key, p] of map) {
    if (matched.has(key)) continue;
    if (divergences.some((d) => d.symbol === p.symbol && d.kind === "conflicting_side")) continue;
    divergences.push({ symbol: p.symbol, kind: "primary_only", primary: p, shadow: null });
  }
  const total = new Set<string>([...a.map((o) => o.symbol), ...b.map((o) => o.symbol)]).size;
  const agreedSymbols = a.filter((o) =>
    b.some((s) => s.symbol === o.symbol && s.side === o.side),
  ).length;
  const agreement = total === 0 ? 1 : agreedSymbols / total;
  return { agreement, divergences };
}

export async function runShadowVariant(args: {
  portfolioId: string;
  decisionId: string | null;
  asOf: string;
  primary: DecisionOutput;
  aiArgs: Parameters<typeof callAiForDecision>[0];
}) {
  const shadow = await callAiForDecision({ ...args.aiArgs, variantSuffix: VARIANT_B_SUFFIX });

  const primaryOrders = normalize(args.primary.orders);
  const shadowOrders = normalize(shadow.orders);
  const { agreement, divergences } = computeAgreement(primaryOrders, shadowOrders);

  await supabaseAdmin.from("shadow_decisions").insert({
    portfolio_id: args.portfolioId,
    decision_id: args.decisionId,
    run_date: args.asOf,
    variant_name: VARIANT_NAME,
    primary_summary: {
      briefing: args.primary.briefing,
      rationale: args.primary.rationale,
      orders: primaryOrders,
    },
    shadow_summary: {
      briefing: shadow.briefing,
      rationale: shadow.rationale,
      orders: shadowOrders,
    },
    agreement,
    primary_order_count: primaryOrders.length,
    shadow_order_count: shadowOrders.length,
    divergences,
  });
}

export async function getShadowReport(portfolioId: string, limit = 30) {
  const { data } = await supabaseAdmin
    .from("shadow_decisions")
    .select("id, run_date, variant_name, agreement, primary_order_count, shadow_order_count, primary_summary, shadow_summary, divergences, created_at")
    .eq("portfolio_id", portfolioId)
    .order("created_at", { ascending: false })
    .limit(limit);
  const rows = data ?? [];
  const n = rows.length;
  const avgAgreement = n ? rows.reduce((s, r) => s + (Number(r.agreement) || 0), 0) / n : null;
  const totalDivergences = rows.reduce((s, r) => s + ((r.divergences as unknown as unknown[])?.length ?? 0), 0);
  return {
    variant_name: VARIANT_NAME,
    samples: n,
    avg_agreement: avgAgreement,
    total_divergences: totalDivergences,
    recent: rows.slice(0, 10),
  };
}
