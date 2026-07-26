// Tail-hedge executor (Phase 6).
//
// `computeTailHedge` returns an *advisory* target notional. This module turns
// that advisory into concrete order-book effects.
//
// Paper / backtest portfolios:  the returned ExecutedTrade is appended and
// `holdingsByS` + `workingCash` are mutated in place so the trades/holdings
// writer in `runDailyTick` persists the hedge alongside every other fill.
//
// Live (live_sim / live_prod) portfolios: we still emit the ExecutedTrade so
// `routeOrdersToBroker` submits the hedge order to Saxo alongside every other
// live order, but we DO NOT mutate holdingsByS/workingCash — the broker is
// authoritative and `live-holdings-sync` reconciles the local mirror after
// routing. Sizing preserves the same no-leverage/no-borrow constraints as
// paper: buys are capped at available cash minus a safety buffer, sells are
// capped at the current held quantity.
//
// Instrument choice: cash-only accounts can't buy SPY puts, so we proxy the
// tail hedge with a physically-backed gold ETC/ETF that already sits in the
// universe. Callers can override per portfolio via `hedgeSymbol`.

import type { Database } from "@/integrations/supabase/types";
import type { TailHedgeDecision } from "./tail-hedge";
import { findSymbol } from "@/lib/universe.server";
import type { ExecutedTrade } from "@/lib/trading-engine.server";

type Holding = Database["public"]["Tables"]["holdings"]["Row"];

export function defaultHedgeSymbolFor(currency: string): string {
  const c = (currency || "GBP").toUpperCase();
  if (c === "USD") return "GLD";
  if (c === "EUR") return "SGLN.L"; // LSE gold ETC quotes in GBp/USD, still Saxo-tradable
  return "SGLN.L";
}

export type TailHedgeExecInputs = {
  decision: TailHedgeDecision;
  holdingsByS: Map<string, Holding>;
  workingCash: number;
  priceMap: Map<string, number>;
  portfolioId: string;
  portfolioCurrency: string;
  isLivePortfolio: boolean;
  hedgeSymbol?: string | null;
  cashBufferPct?: number; // fraction of cash to keep as safety, default 1%
};

export type TailHedgeExecResult = {
  applied: boolean;
  workingCash: number;
  trade?: ExecutedTrade;
  reason: string;
  symbol: string | null;
  qty: number;
  notional: number;
};

export function applyTailHedgeToPaperPortfolio(
  input: TailHedgeExecInputs,
): TailHedgeExecResult {
  const { decision, holdingsByS, priceMap, portfolioId, portfolioCurrency, isLivePortfolio } = input;
  let { workingCash } = input;
  const bufferPct = input.cashBufferPct ?? 0.01;

  const base = {
    applied: false as boolean,
    workingCash,
    symbol: null as string | null,
    qty: 0,
    notional: 0,
  };

  if (decision.action === "hold" || Math.abs(decision.deltaNotional) < 1) {
    return { ...base, reason: `hold: ${decision.reason}` };
  }

  const symbol = (input.hedgeSymbol && input.hedgeSymbol.trim())
    || defaultHedgeSymbolFor(portfolioCurrency);
  const meta = findSymbol(symbol);
  if (!meta) return { ...base, reason: `unknown hedge symbol ${symbol}` };
  const price = priceMap.get(symbol);
  if (!price || price <= 0) return { ...base, reason: `no price for ${symbol}`, symbol };

  const executedAt = new Date().toISOString();

  // Shared no-leverage / no-borrow sizing. For BOTH paper and live modes:
  //   buy  → capped at workingCash * (1 - buffer) (cash-only, never borrow)
  //   sell → capped at current holdings quantity (never short)
  // For live portfolios we additionally do NOT mutate holdingsByS/workingCash;
  // the broker is authoritative and live-holdings-sync reconciles the mirror
  // after routeOrdersToBroker submits the resulting ExecutedTrade to Saxo.
  const mutateLocalState = !isLivePortfolio;

  if (decision.action === "buy") {
    const affordable = Math.max(0, workingCash * (1 - bufferPct));
    const spend = Math.min(decision.deltaNotional, affordable);
    if (spend < price) {
      return { ...base, symbol, reason: `insufficient cash for 1 share of ${symbol}` };
    }
    const qty = spend / price;

    if (mutateLocalState) {
      workingCash -= qty * price;
      const cur = holdingsByS.get(symbol);
      if (cur) {
        const newQty = Number(cur.quantity) + qty;
        const newCost = (Number(cur.avg_cost) * Number(cur.quantity) + qty * price) / newQty;
        const curHwm = Number(
          (cur as unknown as { high_water_mark?: number | null }).high_water_mark ?? Number(cur.avg_cost),
        );
        holdingsByS.set(symbol, {
          ...cur,
          quantity: newQty,
          avg_cost: newCost,
          high_water_mark: Math.max(curHwm, price),
        } as Holding);
      } else {
        holdingsByS.set(symbol, {
          id: crypto.randomUUID(),
          portfolio_id: portfolioId,
          symbol,
          asset_class: meta.asset_class,
          quantity: qty,
          avg_cost: price,
          updated_at: executedAt,
          opened_at: executedAt,
          high_water_mark: price,
        } as Holding);
      }
    }

    const routingNote = isLivePortfolio ? " [live: routed via broker executor]" : "";
    const trade: ExecutedTrade = {
      symbol, side: "buy", quantity: qty, price, value: qty * price,
      reason: `tail_hedge buy → target ${(decision.targetPctNav * 100).toFixed(2)}% NAV (${decision.reason})${routingNote}`,
    };
    return {
      applied: true, workingCash, symbol, qty, notional: qty * price,
      trade, reason: trade.reason,
    };
  }

  // action === "sell": unwind up to |delta| notional of the existing hedge.
  // No-borrow: never sell more than the current held quantity (mirrored from
  // broker for live modes by live-holdings-sync).
  const cur = holdingsByS.get(symbol);
  if (!cur || Number(cur.quantity) <= 1e-8) {
    return { ...base, symbol, reason: `no ${symbol} to unwind` };
  }
  const wantQty = Math.abs(decision.deltaNotional) / price;
  const qty = Math.min(Number(cur.quantity), wantQty);
  if (qty <= 0) return { ...base, symbol, reason: "computed sell qty is zero" };

  if (mutateLocalState) {
    const remaining = Number(cur.quantity) - qty;
    workingCash += qty * price;
    if (remaining <= 1e-8) holdingsByS.delete(symbol);
    else holdingsByS.set(symbol, { ...cur, quantity: remaining } as Holding);
  }

  const routingNote = isLivePortfolio ? " [live: routed via broker executor]" : "";
  const trade: ExecutedTrade = {
    symbol, side: "sell", quantity: qty, price, value: qty * price,
    reason: `tail_hedge sell → target ${(decision.targetPctNav * 100).toFixed(2)}% NAV (${decision.reason})${routingNote}`,
  };
  return {
    applied: true, workingCash, symbol, qty, notional: qty * price,
    trade, reason: trade.reason,
  };
}
