// Reconcile a live portfolio's `trades` ledger against real broker `live_fills`,
// then refresh `holdings` from Saxo. This is the operator-facing "am I actually
// executing?" check for live_sim / live_prod portfolios.
//
// Why this exists: the trading engine writes optimistic `trades` rows on every
// tick BEFORE knowing what the broker did, and does the same for `holdings`.
// For live modes those writes are misleading — the truth lives in `live_fills`
// (populated by the order reconciler) and Saxo's positions endpoint. This
// helper reconciles them:
//
//   1. Rebuild `trades` for the portfolio from `live_fills` so the ledger only
//      contains rows that actually executed at the broker.
//   2. Re-run holdings sync so `holdings` matches Saxo positions exactly.
//   3. Return a diff report so the operator can see which optimistic trades
//      were dropped and which fills were promoted.

import type { Database } from "@/integrations/supabase/types";
import { withOwnedClient } from "@/lib/_server/owned-client";
import { findSymbol } from "@/lib/universe.server";
import { instrumentCcyFor } from "@/lib/instrument-ccy-rules";
import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";
import {
  rebuildLedgerFromFills,
  resolveFillPrice,
  type CloseLookup,
  type FillLite,
} from "@/lib/fills-ledger-rebuild";


type AssetClass = Database["public"]["Enums"]["asset_class"];
const ALLOWED: ReadonlySet<AssetClass> = new Set(["stock", "etf", "fx", "crypto", "commodity"]);

export interface FillsTradesReconcileResult {
  portfolioId: string;
  mode: "live_sim" | "live_prod";
  fillsSeen: number;
  optimisticTradesDropped: number;
  tradesFromFillsInserted: number;
  holdings: {
    skipped: boolean;
    reason?: string;
    brokerPositions?: number;
    keptSymbols?: string[];
    removedSymbols?: string[];
    newTotalValue?: number;
    currency?: string;
  };
}

function classFor(symbol: string): AssetClass {
  const s = findSymbol(symbol);
  const c = (s?.asset_class as AssetClass | undefined) ?? "stock";
  return ALLOWED.has(c) ? c : "stock";
}

export async function reconcileFillsToTradesForPortfolio(
  portfolioId: string,
  userId: string,
): Promise<FillsTradesReconcileResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin;

  const pRes = await admin
    .from("portfolios")
    .select("id, user_id, mode")
    .eq("id", portfolioId)
    .maybeSingle();
  if (pRes.error || !pRes.data) throw new Error("Portfolio not found");
  if (pRes.data.user_id !== userId) throw new Error("Not owned by caller");
  const mode = pRes.data.mode as string;
  if (mode !== "live_sim" && mode !== "live_prod") {
    throw new Error(
      `Fills-to-trades reconcile only applies to live_sim/live_prod portfolios (got ${mode})`,
    );
  }

  // 1. Pull every broker fill this portfolio has ever recorded.
  const fillsRes = await admin
    .from("live_fills")
    .select("id, order_id, symbol, side, quantity, fill_price, fee, currency, broker_fill_id, filled_at")
    .eq("portfolio_id", portfolioId)
    .order("filled_at", { ascending: true });
  if (fillsRes.error) throw new Error(`load live_fills failed: ${fillsRes.error.message}`);
  const fills = fillsRes.data ?? [];

  // 2. Count optimistic (non-fill-derived) trades before rebuild, purely for
  //    the diff report. A "fill-derived" trade is one we previously inserted
  //    via this reconciler and tagged in `reason`.
  const existingRes = await admin
    .from("trades")
    .select("id, reason", { count: "exact" })
    .eq("portfolio_id", portfolioId);
  if (existingRes.error) throw new Error(`load trades failed: ${existingRes.error.message}`);
  const existing = existingRes.data ?? [];
  const optimisticCount = existing.filter(
    (t) => !String(t.reason ?? "").startsWith("[broker-fill]"),
  ).length;

  // 3. Rebuild trades from live_fills — for live portfolios only these are the
  //    authoritative executed trades. Wipe first to keep the ledger canonical.
  await admin.from("trades").delete().eq("portfolio_id", portfolioId);

  // Broker fills often arrive without an average price, and LSE fills arrive
  // in GBX. Resolve missing prices from cached closes and fold everything to
  // base units so the ledger notionals are sane.
  const symbols = [...new Set(fills.map((f) => String(f.symbol)))];
  const closes: CloseLookup = new Map();
  if (symbols.length > 0) {
    const firstDay = (fills[0]?.filled_at as string | null)?.slice(0, 10) ?? "1970-01-01";
    const since = new Date(`${firstDay}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - 10);
    const pc = await admin
      .from("price_cache")
      .select("symbol, price_date, close")
      .in("symbol", symbols)
      .gte("price_date", since.toISOString().slice(0, 10))
      .order("price_date", { ascending: true });
    for (const row of pc.data ?? []) {
      const sym = String(row.symbol);
      const list = closes.get(sym) ?? [];
      list.push({ date: String(row.price_date), close: Number(row.close) });
      closes.set(sym, list);
    }
  }

  const priced = fills
    .filter((f) => Number(f.quantity ?? 0) > 0)
    .map((f) => ({
      ...(f as unknown as FillLite),
      symbol: String(f.symbol),
      price: resolveFillPrice(f as unknown as FillLite, closes),
    }))
    .filter((f) => f.price > 0);

  // Carry the model's confidence from the originating order onto the trade
  // ledger so the trade list can show how sure the model was.
  const convictionByOrder = new Map<string, number>();
  const orderIds = [...new Set(fills.map((f) => f.order_id).filter(Boolean))] as string[];
  if (orderIds.length > 0) {
    const ordRes = await admin
      .from("live_orders")
      .select("id, conviction")
      .in("id", orderIds);
    for (const o of ordRes.data ?? []) {
      const c = Number((o as { conviction?: unknown }).conviction);
      if (Number.isFinite(c)) convictionByOrder.set(String(o.id), c);
    }
  }

  const rows = priced.map((f) => {
    const qty = Number(f.quantity);
    const px = f.price;
    const value = qty * px;
    const filledAtIso = f.filled_at ?? new Date().toISOString();
    const src = fills.find((x) => x.id === f.id);
    const brokerFillId = src?.broker_fill_id ? String(src.broker_fill_id) : String(f.id);
    const rawSide = String(f.side ?? "buy").toLowerCase();
    const side: "buy" | "sell" = rawSide === "sell" ? "sell" : "buy";
    return {
      portfolio_id: portfolioId,
      symbol: f.symbol,
      asset_class: classFor(f.symbol),
      side,
      quantity: qty,
      price: px,
      value,
      executed_at: filledAtIso,
      trade_date: filledAtIso.slice(0, 10),
      reason: `[broker-fill] fill_id=${brokerFillId}`,
      conviction: src?.order_id ? convictionByOrder.get(String(src.order_id)) ?? null : null,
      ...(src?.currency ? { instrument_ccy: String(src.currency) } : {}),
    };
  });


  if (rows.length > 0) {
    const ins = await admin.from("trades").insert(rows);
    if (ins.error) throw new Error(`insert trades failed: ${ins.error.message}`);
  }

  // 4. Refresh holdings from the broker so the tile matches Saxo exactly.
  let holdings: FillsTradesReconcileResult["holdings"] = { skipped: true, reason: "not attempted" };
  try {
    const { reconcileLiveHoldingsFromBroker } = await import("@/lib/live-holdings-sync.server");
    const owned = withOwnedClient(userId);
    const res = await reconcileLiveHoldingsFromBroker(portfolioId, owned);
    if (res.skipped) {
      holdings = { skipped: true, reason: res.reason };
    } else {
      holdings = {
        skipped: false,
        brokerPositions: res.brokerPositions,
        keptSymbols: res.keptSymbols,
        removedSymbols: res.removedSymbols,
        newTotalValue: res.newTotalValue,
        currency: res.currency,
      };
    }
  } catch (e) {
    holdings = { skipped: true, reason: e instanceof Error ? e.message : String(e) };
  }

  // 5. No broker to sync against (unlinked sim portfolio)? Replay the priced
  //    fills locally so holdings and cash still reflect what was executed,
  //    instead of leaving the portfolio looking like it never traded.
  if (holdings.skipped) {
    const ledger = rebuildLedgerFromFills(priced);
    await admin.from("holdings").delete().eq("portfolio_id", portfolioId);
    if (ledger.positions.length > 0) {
      const ins = await admin.from("holdings").insert(
        ledger.positions.map((p) => ({
          portfolio_id: portfolioId,
          symbol: p.symbol,
          asset_class: classFor(p.symbol),
          quantity: p.quantity,
          // Broker fill prices for LSE arrive in GBX; store cost basis in GBP.
          avg_cost: normalizeLseDisplayPriceToBase(p.symbol, p.avgCost, classFor(p.symbol)),
          instrument_ccy: instrumentCcyFor(p.symbol),
        })),
      );
      if (ins.error) throw new Error(`insert holdings failed: ${ins.error.message}`);
    }
    const pf = await admin
      .from("portfolios")
      .select("starting_cash")
      .eq("id", portfolioId)
      .maybeSingle();
    const start = Number(pf.data?.starting_cash ?? 0);
    if (Number.isFinite(start) && start > 0) {
      await admin
        .from("portfolios")
        .update({ current_cash: Math.max(0, start + ledger.cashDelta) })
        .eq("id", portfolioId);
    }
    holdings = {
      skipped: false,
      reason: `local-rebuild (${holdings.reason ?? "broker sync unavailable"})`,
      brokerPositions: ledger.positions.length,
      keptSymbols: ledger.positions.map((p) => p.symbol),
      removedSymbols: [],
    };
  }


  return {
    portfolioId,
    mode: mode as "live_sim" | "live_prod",
    fillsSeen: fills.length,
    optimisticTradesDropped: optimisticCount,
    tradesFromFillsInserted: rows.length,
    holdings,
  };
}
