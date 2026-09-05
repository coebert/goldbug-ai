/**
 * Build this account's risk profile from its real records: `equity_snapshots`
 * for the curve, `trades` for closed round trips, `holdings` for live
 * exposure, and `live_fills` for what dealing actually cost.
 *
 * Best-effort by design — every failure returns null so a decision tick never
 * breaks over a missing history table.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  equityRisk,
  exposureStats,
  formatRiskProfileBlock,
  tradeStats,
  type BookRiskProfile,
  type ClosedTrade,
  type OpenPosition,
} from "./risk-profile";

const WINDOW_DAYS = 180;

function baseSymbol(symbol: string): string {
  return (symbol.split(":")[0] ?? symbol).trim().toUpperCase();
}

function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));
}

/**
 * FIFO-free average-cost replay of this book's own fills into closed round
 * trips. Matches the convention `holdings.avg_cost` already uses, so realised
 * returns here line up with the unrealised numbers on the same page.
 */
export function closedTradesFromFills(
  rows: Array<{ symbol: string; side: string; quantity: number; price: number; trade_date: string }>,
): ClosedTrade[] {
  const positions = new Map<string, { qty: number; avgCost: number; openedOn: string }>();
  const closed: ClosedTrade[] = [];
  for (const t of rows) {
    const key = baseSymbol(String(t.symbol));
    const qty = Math.abs(Number(t.quantity) || 0);
    const price = Number(t.price) || 0;
    const date = String(t.trade_date);
    if (!(qty > 0) || !(price > 0)) continue;
    const pos = positions.get(key);
    if (String(t.side) === "buy") {
      if (pos && pos.qty > 0) {
        const total = pos.qty + qty;
        pos.avgCost = (pos.avgCost * pos.qty + price * qty) / total;
        pos.qty = total;
      } else positions.set(key, { qty, avgCost: price, openedOn: date });
      continue;
    }
    if (!pos || pos.qty <= 0) continue;
    const sold = Math.min(qty, pos.qty);
    const cost = pos.avgCost * sold;
    const proceeds = price * sold;
    closed.push({
      symbol: key,
      pnl: proceeds - cost,
      returnPct: cost > 0 ? proceeds / cost - 1 : 0,
      heldDays: daysBetween(pos.openedOn, date),
      notional: proceeds,
      closedOn: date,
    });
    pos.qty -= sold;
    if (pos.qty <= 1e-9) positions.delete(key);
  }
  return closed;
}

export async function loadRiskProfile(args: {
  portfolioId: string;
  nav: number;
  cash: number;
  asOf: string;
  /** Live price per holding symbol, base major units. Missing names fall back to cost. */
  priceBySymbol?: Map<string, number> | Record<string, number>;
}): Promise<{ profile: BookRiskProfile; positions: OpenPosition[] } | null> {
  const from = new Date(Date.parse(args.asOf) - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [{ data: equity }, { data: trades }, { data: holdings }, { data: fills }] = await Promise.all([
    supabaseAdmin
      .from("equity_snapshots")
      .select("snapshot_date, total_value")
      .eq("portfolio_id", args.portfolioId)
      .gte("snapshot_date", from)
      .order("snapshot_date", { ascending: true }),
    supabaseAdmin
      .from("trades")
      .select("symbol, side, quantity, price, trade_date")
      .eq("portfolio_id", args.portfolioId)
      .gte("trade_date", from)
      .order("trade_date", { ascending: true }),
    supabaseAdmin
      .from("holdings")
      .select("symbol, quantity, avg_cost, opened_at")
      .eq("portfolio_id", args.portfolioId),
    supabaseAdmin
      .from("live_fills")
      .select("fee, filled_at")
      .eq("portfolio_id", args.portfolioId)
      .gte("filled_at", from),
  ]);

  const priceOf = (symbol: string): number | null => {
    const src = args.priceBySymbol;
    if (!src) return null;
    const keys = [symbol, baseSymbol(symbol)];
    for (const k of keys) {
      const v = src instanceof Map ? src.get(k) : (src as Record<string, number>)[k];
      if (Number.isFinite(v) && (v as number) > 0) return v as number;
    }
    return null;
  };

  const positions: OpenPosition[] = (holdings ?? [])
    .filter((h) => Number(h.quantity) !== 0)
    .map((h) => {
      const qty = Number(h.quantity) || 0;
      const cost = Number(h.avg_cost) || 0;
      const price = priceOf(String(h.symbol));
      const value = (price ?? cost) * qty;
      const unrealised = price != null ? (price - cost) * qty : null;
      return {
        symbol: String(h.symbol),
        value: Math.abs(value),
        unrealised,
        unrealisedPct: unrealised != null && cost > 0 && qty !== 0
          ? ((price as number) / cost - 1) * 100
          : null,
        heldDays: h.opened_at ? daysBetween(String(h.opened_at).slice(0, 10), args.asOf) : null,
      };
    });

  const closed = closedTradesFromFills(
    (trades ?? []).map((t) => ({
      symbol: String(t.symbol),
      side: String(t.side),
      quantity: Number(t.quantity),
      price: Number(t.price),
      trade_date: String(t.trade_date),
    })),
  );

  const feeTotal = (fills ?? []).reduce((a, f) => a + (Number(f.fee) || 0), 0);

  const profile: BookRiskProfile = {
    ...equityRisk(
      (equity ?? []).map((e) => ({
        date: String(e.snapshot_date),
        value: Number(e.total_value) || 0,
      })),
    ),
    trades: tradeStats(closed, args.nav),
    book: exposureStats(positions, args.nav, args.cash),
    frictionBpsOfNav: args.nav > 0 && feeTotal > 0 ? (feeTotal / args.nav) * 10_000 : null,
  };

  return { profile, positions };
}

/** Prompt block for the decision call; null when there is nothing to say. */
export async function buildRiskProfileBlock(args: {
  portfolioId: string;
  nav: number;
  cash: number;
  asOf: string;
  currency: string;
  priceBySymbol?: Map<string, number> | Record<string, number>;
}): Promise<string | null> {
  const loaded = await loadRiskProfile(args);
  if (!loaded) return null;
  const { profile, positions } = loaded;
  // Nothing measured yet: no curve and no trades means the block would be all
  // "n/a", which only wastes prompt budget.
  if (profile.days < 2 && profile.trades.n === 0 && positions.length === 0) return null;
  return formatRiskProfileBlock(profile, {
    currency: args.currency,
    windowDays: WINDOW_DAYS,
    positions,
    nav: args.nav,
  });
}
