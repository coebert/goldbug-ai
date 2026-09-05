/**
 * Today's book, in the exact shape the learned model was trained on.
 *
 * The dataset builder rebuilds position size, holding age, cash share,
 * drawdown and a decayed memory of realised losses for every past day. This
 * does the same for right now, so scoring sees like-for-like inputs.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { BookSnapshot } from "./model.server";

const LOSS_MEMORY_HALFLIFE_DAYS = 30;

function baseSymbol(symbol: string): string {
  return (symbol.split(":")[0] ?? symbol).trim().toUpperCase();
}

export async function loadBookSnapshot(args: {
  portfolioId: string;
  totalValue: number;
  cash: number;
  asOf?: string;
}): Promise<BookSnapshot> {
  const asOf = args.asOf ?? new Date().toISOString().slice(0, 10);
  const snapshot: BookSnapshot = {
    totalValue: args.totalValue,
    cash: args.cash,
    peakValue: args.totalValue,
    holdings: [],
    lossMemory: {},
    asOf,
  };

  const [{ data: holdings }, { data: equity }, { data: trades }] = await Promise.all([
    supabaseAdmin
      .from("holdings")
      .select("symbol, quantity, avg_cost, opened_at")
      .eq("portfolio_id", args.portfolioId),
    supabaseAdmin
      .from("equity_snapshots")
      .select("total_value")
      .eq("portfolio_id", args.portfolioId)
      .order("total_value", { ascending: false })
      .limit(1),
    supabaseAdmin
      .from("trades")
      .select("symbol, side, quantity, price, trade_date")
      .eq("portfolio_id", args.portfolioId)
      .gte("trade_date", new Date(Date.parse(asOf) - 400 * 86_400_000).toISOString().slice(0, 10))
      .order("trade_date", { ascending: true }),
  ]);

  snapshot.holdings = (holdings ?? []).map((h) => ({
    symbol: String(h.symbol),
    quantity: Number(h.quantity) || 0,
    avg_cost: Number(h.avg_cost) || 0,
    opened_at: h.opened_at ? String(h.opened_at) : null,
  }));

  const peak = Number(equity?.[0]?.total_value) || 0;
  snapshot.peakValue = Math.max(peak, args.totalValue);

  // Replay trades to bank realised losses, then decay them by age.
  const positions = new Map<string, { qty: number; avgCost: number }>();
  const losses: Array<{ symbol: string; date: string; amount: number }> = [];
  for (const t of trades ?? []) {
    const key = baseSymbol(String(t.symbol));
    const qty = Math.abs(Number(t.quantity) || 0);
    const price = Number(t.price) || 0;
    if (!(qty > 0) || !(price > 0)) continue;
    const pos = positions.get(key);
    if (String(t.side) === "buy") {
      if (pos && pos.qty > 0) {
        const total = pos.qty + qty;
        pos.avgCost = (pos.avgCost * pos.qty + price * qty) / total;
        pos.qty = total;
      } else positions.set(key, { qty, avgCost: price });
      continue;
    }
    if (!pos || pos.qty <= 0) continue;
    const sold = Math.min(qty, pos.qty);
    const realised = (price - pos.avgCost) * sold;
    if (realised < 0) losses.push({ symbol: key, date: String(t.trade_date), amount: realised });
    pos.qty -= sold;
    if (pos.qty <= 1e-9) positions.delete(key);
  }

  if (args.totalValue > 0) {
    const memory: Record<string, number> = {};
    for (const l of losses) {
      const age = Math.round((Date.parse(asOf) - Date.parse(l.date)) / 86_400_000);
      if (age < 0 || age > 180) continue;
      const decayed = (l.amount * Math.pow(0.5, age / LOSS_MEMORY_HALFLIFE_DAYS)) / args.totalValue;
      memory[l.symbol] = Math.max(-1, (memory[l.symbol] ?? 0) + decayed);
    }
    snapshot.lossMemory = memory;
  }

  return snapshot;
}
