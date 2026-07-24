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

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { ScopedDbClient } from "@/lib/live-cash-sync.server";

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

const ALLOWED_ASSET_CLASSES = new Set([
  "stock", "etf", "fund", "bond", "fx", "crypto", "commodity",
]);

function saxoAssetToClass(assetType: string | undefined): string {
  const a = (assetType ?? "").toLowerCase();
  if (a === "stock") return "stock";
  if (a === "etf" || a === "etc") return "etf";
  if (a === "fund") return "fund";
  if (a === "bond") return "bond";
  if (a.includes("fx")) return "fx";
  return "stock";
}

export async function reconcileLiveHoldingsFromBroker(
  portfolioId: string,
  client?: ScopedDbClient,
): Promise<LiveHoldingsSyncResult> {
  // Same pattern as syncLiveCashFromBroker: prefer the caller's user-scoped
  // client so RLS enforces ownership; admin only for cron paths.
  const db = client ?? supabaseAdmin;
  const { data: p, error } = await db
    .from("portfolios")
    .select("id, user_id, mode, live_paused")
    .eq("id", portfolioId)
    .maybeSingle();
  if (error || !p) return { skipped: true, reason: "portfolio not found" };
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

  const env = p.mode === "live_prod" ? "live" : "sim";
  let brokerCash: number;
  let currency: string;
  let positions: Array<{
    symbol: string; quantity: number; avgPrice: number;
    marketPrice: number; assetType: string;
  }>;
  try {
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const adapter = await buildSaxoAdapter({
      userId: p.user_id, portfolioId, envOverride: env,
    });
    const [bal, pos] = await Promise.all([
      adapter.getBalance(),
      adapter.getPositions(),
    ]);
    brokerCash = Number(bal.cashAvailable ?? bal.cash);
    currency = bal.currency;
    positions = pos;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("live_broker_log").insert({
      portfolio_id: portfolioId, user_id: p.user_id,
      broker: "saxo", env,
      method: "HOLDINGS_SYNC", path: "/sync/holdings",
      status: 502,
      request: {} as never, response: null,
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
  const rowsToUpsert = positions
    .filter((p) => p.symbol && Math.abs(p.quantity) > 1e-8)
    .map((p) => ({
      portfolio_id: portfolioId,
      symbol: p.symbol,
      asset_class: (ALLOWED_ASSET_CLASSES.has(saxoAssetToClass(p.assetType))
        ? saxoAssetToClass(p.assetType)
        : "stock") as never,
      quantity: p.quantity,
      avg_cost: p.avgPrice || p.marketPrice || 0,
      high_water_mark: p.avgPrice || p.marketPrice || 0,
    }));
  if (rowsToUpsert.length > 0) {
    await db.from("holdings").upsert(
      rowsToUpsert as never,
      { onConflict: "portfolio_id,symbol" },
    );
  }

  // Recompute equity from broker prices + broker cash.
  const holdingsValue = positions.reduce(
    (sum, p) => sum + (p.marketPrice || p.avgPrice || 0) * p.quantity,
    0,
  );
  const newTotal = brokerCash + holdingsValue;

  await db.from("portfolios")
    .update({ current_cash: brokerCash })
    .eq("id", portfolioId);

  const asOf = new Date().toISOString().slice(0, 10);
  await db.from("equity_snapshots").upsert(
    {
      portfolio_id: portfolioId,
      snapshot_date: asOf,
      cash: brokerCash,
      holdings_value: holdingsValue,
      total_value: newTotal,
    },
    { onConflict: "portfolio_id,snapshot_date" },
  );

  await db.from("live_broker_log").insert({
    portfolio_id: portfolioId, user_id: p.user_id,
    broker: "saxo", env,
    method: "HOLDINGS_SYNC", path: "/sync/holdings",
    status: 200,
    request: { localSymbols } as never,
    response: {
      brokerCash, currency, holdingsValue, newTotal,
      brokerPositions: positions.length,
      removedSymbols,
      keptSymbols: Array.from(brokerSymbols),
    } as never,
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
