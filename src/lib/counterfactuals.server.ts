// G. Counterfactual logging — record candidates the guardrails blocked so we
// can later evaluate whether skipping them saved or cost the portfolio.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPriceOn } from "./market-data.server";

export type BlockCategory =
  | "cooldown"
  | "gap_guard"
  | "gross_exposure"
  | "asset_class_cap"
  | "correlation_cluster"
  | "per_symbol_cap"
  | "min_trade_size"
  | "circuit_breaker"
  | "retail_mania"
  | "other";

export function categorize(reason: string): BlockCategory {
  const r = reason.toLowerCase();
  if (r.includes("retail-mania") || r.includes("retail mania")) return "retail_mania";
  if (r.includes("gap")) return "gap_guard";
  if (r.includes("cooldown")) return "cooldown";
  if (r.includes("asset-class") || r.includes("class cap")) return "asset_class_cap";
  if (r.includes("cluster") || r.includes("corr")) return "correlation_cluster";
  if (r.includes("gross")) return "gross_exposure";
  if (r.includes("liquidity") || r.includes("min trade") || r.includes("too small")) return "min_trade_size";
  if (r.includes("circuit") || r.includes("breaker")) return "circuit_breaker";
  if (r.includes("cap")) return "per_symbol_cap";
  return "other";
}

export async function logCounterfactual(row: {
  portfolioId: string;
  asOf: string;
  symbol: string;
  side: "buy" | "sell";
  hypotheticalPrice: number;
  blockReason: string;
  hypotheticalSpend?: number | null;
  conviction?: number | null;
}) {
  await supabaseAdmin.from("counterfactuals").insert({
    portfolio_id: row.portfolioId,
    as_of: row.asOf,
    symbol: row.symbol,
    side: row.side,
    hypothetical_price: row.hypotheticalPrice,
    block_reason: row.blockReason.slice(0, 240),
    block_category: categorize(row.blockReason),
    hypothetical_spend: row.hypotheticalSpend ?? null,
    conviction: row.conviction ?? null,
  });
}

/**
 * Evaluate any counterfactuals whose 5d forward window has fully elapsed.
 * A positive forward_return_5d means the block "cost" us (buy candidate rose),
 * negative means the block "saved" us.
 */
export async function evaluatePendingCounterfactuals(asOf: string) {
  const cutoff = new Date(asOf);
  cutoff.setUTCDate(cutoff.getUTCDate() - 5);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { data: pending } = await supabaseAdmin
    .from("counterfactuals")
    .select("id, symbol, side, hypothetical_price, as_of")
    .is("evaluated_at", null)
    .gt("hypothetical_price", 0)
    .lte("as_of", cutoffStr)
    .limit(200);
  if (!pending || pending.length === 0) return 0;

  let done = 0;
  for (const cf of pending) {
    try {
      const fwd = new Date(cf.as_of as string);
      fwd.setUTCDate(fwd.getUTCDate() + 5);
      const price = await getPriceOn(cf.symbol as string, fwd.toISOString().slice(0, 10));
      if (!price) continue;
      const rawRet = (price - Number(cf.hypothetical_price)) / Number(cf.hypothetical_price);
      const ret = cf.side === "sell" ? -rawRet : rawRet;
      await supabaseAdmin
        .from("counterfactuals")
        .update({ forward_return_5d: ret, evaluated_at: new Date().toISOString() })
        .eq("id", cf.id);
      done++;
    } catch {
      /* skip */
    }
  }
  return done;
}
