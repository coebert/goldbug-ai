// Reconcile a live portfolio's local holdings + cash from the broker so
// they mirror what Saxo actually holds. The trading engine writes trades /
// holdings / cash BEFORE knowing whether the broker accepted the order, so
// without this reconciliation the local state silently diverges whenever a
// Saxo order is rejected, errors, or is skipped (e.g. FX pairs on retail
// cash accounts, sub-share quantities, etc.).
//
// This is the authoritative source for live_prod (and live_sim when the
// paper-only kill-switch is off): broker cash + broker positions overwrite
// local, and today's equity_snapshot is rewritten to match. Positions the
// broker doesn't hold are removed from `holdings`; positions the broker
// does hold are upserted with the broker's average price.
//
// The function never throws upward — a broker outage is logged and skipped
// so the tick can proceed. Small cash drifts (< 0.5 in account currency)
// are still applied because the broker is authoritative here; only true
// broker read failures leave local state alone.

import { recordIntradayEquity } from "@/lib/equity-intraday.server";
import { valueBrokerPositions } from "@/lib/broker-positions-value";

import { recordIntradayPrices } from "@/lib/price-intraday.server";

import { resolvePortfolioBrokerLink } from "@/lib/brokers/portfolio-broker-link.server";
import { asJson, type Insert } from "@/lib/_server/db-json";
import { instrumentCcyFor } from "@/lib/instrument-ccy-rules";
import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";
import { writeEquitySnapshot } from "@/lib/valuation/write-snapshot.server";
import type { Database } from "@/integrations/supabase/types";
import type { OwnedDbClient } from "@/lib/_server/owned-client";

type AssetClass = Database["public"]["Enums"]["asset_class"];


export type LiveHoldingsSyncResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      brokerCash: number;
      brokerPositions: number;
      removedSymbols: string[];
      keptSymbols: string[];
      newTotalValue: number;
      currency: string;
    };
// asset_class is a Postgres enum — restrict to the values the DB accepts so
// TS enforces the mapping. Anything else falls back to "stock".
const ALLOWED_ASSET_CLASSES = new Set<AssetClass>([
  "stock", "etf", "fx", "crypto", "commodity",
]);

function saxoAssetToClass(assetType: string | undefined): AssetClass {
  const a = (assetType ?? "").toLowerCase();
  if (a === "stock") return "stock";
  if (a === "etf" || a === "etc") return "etf";
  if (a.includes("fx")) return "fx";
  if (a === "crypto") return "crypto";
  if (a === "commodity") return "commodity";
  return "stock";
}


export async function reconcileLiveHoldingsFromBroker(
  portfolioId: string,
  owned: OwnedDbClient,
): Promise<LiveHoldingsSyncResult> {
  // Same pattern as syncLiveCashFromBroker: prefer the caller's user-scoped
  // client so RLS enforces ownership; on the admin branch (cron) RLS is
  // bypassed and we add `.eq("user_id", userId)` on the top-level portfolio
  // lookup as defence-in-depth. Downstream `.eq("portfolio_id", …)` calls
  // are safe on both branches once portfolio ownership has been proven.
  const { db, userId, isAdmin } = owned;

  const portfolioQuery = db
    .from("portfolios")
    .select("id, user_id, mode, live_paused, broker, broker_account_id")
    .eq("id", portfolioId);
  const { data: p, error } = await (isAdmin
    ? portfolioQuery.eq("user_id", userId)
    : portfolioQuery
  ).maybeSingle();
  if (error || !p) return { skipped: true, reason: "portfolio not found" };
  if (p.user_id !== userId) {
    return { skipped: true, reason: "portfolio not owned by caller" };
  }
  if (p.mode !== "live_sim" && p.mode !== "live_prod") {
    return { skipped: true, reason: "not a live portfolio" };
  }

  // Respect the paper-only kill switch for live_sim so we don't wipe
  // simulated paper holdings when live_sim is intentionally not routed.
  if (p.mode === "live_sim") {
    const flag = (process.env.LIVE_SIM_PAPER_ONLY ?? "").toLowerCase();
    if (flag === "1" || flag === "true" || flag === "yes") {
      return { skipped: true, reason: "live_sim in paper-only mode" };
    }
  }

  // Broker positions may only replace the holdings of a portfolio that is
  // linked to its own broker account (see portfolio-broker-link.server.ts).
  const link = resolvePortfolioBrokerLink(p);
  if (!link.linked) return { skipped: true, reason: link.reason };

  const env = p.mode === "live_prod" ? "live" : "sim";
  let brokerCash: number;
  let brokerTotalValue: number | null = null;
  let currency: string;
  let positions: Array<{
    symbol: string; quantity: number; avgPrice: number;
    marketPrice: number; assetType: string;
  }>;
  try {
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const adapter = await buildSaxoAdapter({
      userId: p.user_id, portfolioId, envOverride: env,
      accountKey: link.accountKey,
    });
    const [bal, pos] = await Promise.all([
      adapter.getBalance(),
      adapter.getPositions(),
    ]);
    // Use settled cash (bal.cash) rather than cashAvailable for the ledger:
    // cashAvailable can be reduced by pending orders, which would understate
    // free cash relative to what the Saxo app shows on the account summary.
    brokerCash = Number(bal.cash);
    brokerTotalValue = Number.isFinite(Number(bal.totalValue)) ? Number(bal.totalValue) : null;
    currency = bal.currency;
    positions = pos;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("live_broker_log").insert({
      portfolio_id: portfolioId, user_id: p.user_id,
      broker: "saxo", env,
      method: "HOLDINGS_SYNC", path: "/sync/holdings",
      status: 502,
      request: asJson({}), response: null,
      error: `broker read failed: ${msg}`,
    });
    return { skipped: true, reason: `broker read failed: ${msg}` };
  }


  const brokerSymbols = new Set(
    positions
      .filter((p) => p.symbol && Math.abs(p.quantity) > 1e-8)
      .map((p) => p.symbol.toUpperCase()),
  );

  // Load existing local holdings so we know what to delete.
  const existing = await db
    .from("holdings").select("symbol")
    .eq("portfolio_id", portfolioId);
  const localSymbols = (existing.data ?? []).map((r) => r.symbol);

  const removedSymbols = localSymbols.filter(
    (s) => !brokerSymbols.has(s.toUpperCase()),
  );
  if (removedSymbols.length > 0) {
    await db.from("holdings")
      .delete().eq("portfolio_id", portfolioId)
      .in("symbol", removedSymbols);
  }

  // Upsert broker positions as local holdings.
  const rowsToUpsert: Insert<"holdings">[] = positions
    .filter((p) => p.symbol && Math.abs(p.quantity) > 1e-8)
    .map((p) => {
      const mapped = saxoAssetToClass(p.assetType);
      const asset_class: AssetClass = ALLOWED_ASSET_CLASSES.has(mapped) ? mapped : "stock";
      // Saxo quotes LSE common stock in GBX (pence) while every stored number
      // in Aegis is in the instrument's base unit (GBP). Storing the raw
      // pence average made cost basis 100x the marked price, which surfaced
      // as "divisor ÷100 vs ÷1" mismatches on MKS/HSBA/ULVR/TSCO.
      const rawCost = p.avgPrice || p.marketPrice || 0;
      const avgCostBase = normalizeLseDisplayPriceToBase(p.symbol, rawCost, asset_class);
      return {
        portfolio_id: portfolioId,
        symbol: p.symbol,
        asset_class,
        quantity: p.quantity,
        avg_cost: avgCostBase,
        high_water_mark: avgCostBase,
        // Tagging rules own the settlement currency: broker payloads often
        // echo the account currency, which would skip the FX leg.
        instrument_ccy: instrumentCcyFor(p.symbol),
      };
    });
  if (rowsToUpsert.length > 0) {
    await db.from("holdings").upsert(
      rowsToUpsert,
      { onConflict: "portfolio_id,symbol" },
    );
  }

  // Recompute equity from broker prices + broker cash, but PREFER Saxo's
  // authoritative TotalValue when it's present so the headline number in Aegis
  // matches the account summary shown in the Saxo app (which folds in bits our
  // per-position math can miss — currency conversion at Saxo's rate, cash sub-
  // accounts, un-booked corporate actions, etc.).
  // Saxo quotes LSE instruments in pence (GBX) while the account currency is
  // GBP. Fold those quotes to the base unit before summing, otherwise this
  // fallback values every :xlon position 100x too high — which surfaced as a
  // ~GBP 817k headline for a ~GBP 10.2k account whenever Saxo's authoritative
  // TotalValue was missing from the response.
  const holdingsValueLocal = valueBrokerPositions(
    positions.map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      marketPrice: p.marketPrice,
      avgPrice: p.avgPrice,
      assetClass: saxoAssetToClass(p.assetType),
    })),
  );


  const newTotal =
    brokerTotalValue != null && brokerTotalValue > 0
      ? brokerTotalValue
      : brokerCash + holdingsValueLocal;
  // Derive holdings_value from the authoritative total so cash + holdings_value
  // always reconciles to total_value (avoids double-counting or off-by-one drift).
  const holdingsValue = Math.max(0, newTotal - brokerCash);

  await db.from("portfolios")
    .update({ current_cash: brokerCash })
    .eq("id", portfolioId);

  const asOf = new Date().toISOString().slice(0, 10);
  await writeEquitySnapshot(db as never, {
    portfolioId,
    snapshotDate: asOf,
    cash: brokerCash,
    holdingsValue,
    totalValue: newTotal,
    // Broker figures are authoritative: the gate still enforces the
    // arithmetic invariants but does not second-guess the size of the move.
    source: "broker_sync",
  });

  await recordIntradayEquity(db as never, portfolioId, {
    cash: brokerCash,
    holdingsValue,
    totalValue: newTotal,
  });

  // The broker just told us each instrument's live price; bucket it by hour so
  // holding sparklines can show intraday detail instead of one daily close.
  // price_intraday is shared reference data: only service_role may write it, so
  // this must NOT go through the request-scoped (user JWT) client or every
  // upsert is rejected by RLS and sparklines stay flat.
  {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await recordIntradayPrices(
      supabaseAdmin as never,
      positions.map((p) => ({ symbol: p.symbol, price: p.marketPrice || p.avgPrice || 0 })),
    );
  }


  await db.from("live_broker_log").insert({
    portfolio_id: portfolioId, user_id: p.user_id,
    broker: "saxo", env,
    method: "HOLDINGS_SYNC", path: "/sync/holdings",
    status: 200,
    request: asJson({ localSymbols }),
    response: asJson({
      brokerCash, currency, holdingsValue, holdingsValueLocal,
      brokerTotalValue, newTotal,
      brokerPositions: positions.length,
      removedSymbols,
      keptSymbols: Array.from(brokerSymbols),
    }),
    error: null,
  });


  return {
    skipped: false,
    brokerCash,
    brokerPositions: positions.length,
    removedSymbols,
    keptSymbols: Array.from(brokerSymbols),
    newTotalValue: newTotal,
    currency,
  };
}
