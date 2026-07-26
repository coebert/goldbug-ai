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

  const rows = fills
    .filter((f) => Number(f.quantity ?? 0) > 0)
    .map((f) => {
      const qty = Number(f.quantity);
      const px = Number(f.fill_price ?? 0);
      const value = qty * px;
      const filledAtIso = (f.filled_at as string | null) ?? new Date().toISOString();
      const brokerFillId = f.broker_fill_id ? String(f.broker_fill_id) : String(f.id);
      const rawSide = String(f.side ?? "buy").toLowerCase();
      const side: "buy" | "sell" = rawSide === "sell" ? "sell" : "buy";
      return {
        portfolio_id: portfolioId,
        symbol: f.symbol as string,
        asset_class: classFor(f.symbol as string),
        side,
        quantity: qty,
        price: px,
        value,
        executed_at: filledAtIso,
        trade_date: filledAtIso.slice(0, 10),
        reason: `[broker-fill] fill_id=${brokerFillId}`,
        ...(f.currency ? { instrument_ccy: String(f.currency) } : {}),
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

  return {
    portfolioId,
    mode: mode as "live_sim" | "live_prod",
    fillsSeen: fills.length,
    optimisticTradesDropped: optimisticCount,
    tradesFromFillsInserted: rows.length,
    holdings,
  };
}
