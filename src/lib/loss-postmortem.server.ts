// Server-side loader for the loss post-mortem memory: reconstruct realised
// round-trips from the trade ledger (pooled across the user's portfolios so
// lessons carry over) and hand them to the pure aggregator.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildLossPostmortems,
  type RoundTrip,
  type SymbolPostmortem,
} from "./alpha/loss-postmortem";

type TradeRow = {
  symbol: string;
  side: string;
  price: number;
  quantity: number;
  trade_date: string;
  reason: string | null;
};

/** FIFO-match buys against sells to produce realised round-trips. */
export function roundTripsFromTrades(trades: TradeRow[]): RoundTrip[] {
  const lots = new Map<string, Array<{ qty: number; price: number; date: string }>>();
  const trips: RoundTrip[] = [];

  for (const t of [...trades].sort((a, b) => a.trade_date.localeCompare(b.trade_date))) {
    const sym = String(t.symbol).toUpperCase();
    const qty = Number(t.quantity);
    const price = Number(t.price);
    if (!(qty > 0) || !(price > 0)) continue;

    if (t.side === "buy") {
      const list = lots.get(sym) ?? [];
      list.push({ qty, price, date: t.trade_date });
      lots.set(sym, list);
      continue;
    }
    if (t.side !== "sell") continue;

    let remaining = qty;
    const list = lots.get(sym) ?? [];
    while (remaining > 1e-9 && list.length > 0) {
      const lot = list[0];
      const take = Math.min(remaining, lot.qty);
      const holdDays = Math.max(
        0,
        Math.round(
          (Date.parse(`${t.trade_date}T00:00:00Z`) - Date.parse(`${lot.date}T00:00:00Z`)) /
            86_400_000,
        ),
      );
      trips.push({
        symbol: sym,
        exitDate: t.trade_date,
        returnPct: (price - lot.price) / lot.price,
        holdDays,
        exitReason: t.reason ?? null,
      });
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-9) list.shift();
    }
    lots.set(sym, list);
  }
  return trips;
}

/**
 * Symbol → decaying loss memory across every portfolio owned by the same
 * user as `portfolioId`. Best-effort: any failure yields an empty map so the
 * tick keeps running.
 */
export async function loadLossPostmortems(
  portfolioId: string,
  asOf: string,
  lookbackDays = 180,
): Promise<Map<string, SymbolPostmortem>> {
  try {
    const { data: pf } = await supabaseAdmin
      .from("portfolios")
      .select("user_id")
      .eq("id", portfolioId)
      .maybeSingle();
    const userId = (pf as { user_id?: string } | null)?.user_id ?? null;

    let scopeIds = [portfolioId];
    if (userId) {
      const { data: rows } = await supabaseAdmin
        .from("portfolios")
        .select("id")
        .eq("user_id", userId);
      const ids = (rows ?? []).map((r) => r.id as string);
      if (ids.length) scopeIds = ids;
    }

    const since = new Date(Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`) - lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const { data: trades } = await supabaseAdmin
      .from("trades")
      .select("symbol, side, price, quantity, trade_date, reason")
      .in("portfolio_id", scopeIds)
      .gte("trade_date", since)
      .lte("trade_date", asOf)
      .order("trade_date", { ascending: true });

    return buildLossPostmortems(roundTripsFromTrades((trades ?? []) as TradeRow[]), asOf);
  } catch (err) {
    console.warn("loadLossPostmortems: falling back to empty memory", err);
    return new Map();
  }
}
