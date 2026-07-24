// Server-only helpers extracted from live.functions.ts so that
// live.functions.ts can stay a thin wrapper (see tanstack-serverfn-splitting
// knowledge). Contains the audit-log writer, drift detector, and the
// reconciliation core that the cron route imports directly.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { withOwnedClient } from "@/lib/_server/owned-client";
import type { ScopedDbClient } from "@/lib/_server/owned-client";

export async function logAudit(params: {
  userId: string;
  portfolioId?: string | null;
  action: string; // e.g. KILL_SWITCH, RESUME_ALL, PAUSE, ACTIVATE, DEACTIVATE
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  env?: string;
  status?: number;
  error?: string | null;
}) {
  try {
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: params.portfolioId ?? null,
      user_id: params.userId,
      broker: "local",
      env: params.env ?? "n/a",
      method: params.action,
      path: `/audit/${params.action.toLowerCase()}`,
      status: params.status ?? 200,
      request: params.request as never,
      response: params.response as never,
      error: params.error ?? null,
    });
  } catch (e) {
    console.error("audit log write failed", params.action, e);
  }
}

export function detectPositionDrift(
  broker: Array<{ symbol: string; quantity: number }>,
  local: Array<{ symbol: string; quantity: number }>,
): string[] {
  const out: string[] = [];
  const bMap = new Map(broker.map((b) => [b.symbol, b.quantity]));
  const lMap = new Map(local.map((l) => [l.symbol, l.quantity]));
  const all = new Set([...bMap.keys(), ...lMap.keys()]);
  for (const s of all) {
    const b = bMap.get(s) ?? 0;
    const l = lMap.get(s) ?? 0;
    if (Math.abs(b - l) > 1e-6) out.push(`${s}(broker=${b},local=${l})`);
  }
  return out;
}

// Shared reconciliation core (also called from the cron route at
// src/routes/api/public/hooks/live-reconcile.ts).
export async function runReconciliation(
  userId: string,
  portfolioId: string,
  client?: ScopedDbClient,
) {
  // Same pattern as the sidecars: pass the caller's user-scoped client through
  // so every write below is enforced by RLS. Cron paths omit the arg → admin.
  const db = client ?? supabaseAdmin;
  const { syncLiveCashFromBroker } = await import("@/lib/live-cash-sync.server");
  await syncLiveCashFromBroker(portfolioId, client);
  const { reconcileLiveHoldingsFromBroker } = await import(
    "@/lib/live-holdings-sync.server"
  );
  await reconcileLiveHoldingsFromBroker(portfolioId, client);
  const p = await db.from("portfolios")
    .select("id, user_id, mode, current_cash").eq("id", portfolioId).maybeSingle();
  if (p.error || !p.data) throw new Error("Portfolio not found");
  if (p.data.user_id !== userId) throw new Error("Not owned by caller");
  if (p.data.mode !== "live_sim" && p.data.mode !== "live_prod") {
    return { skipped: true, reason: "not live" };
  }

  const env = p.data.mode === "live_prod" ? "live" : "sim";
  const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
  const adapter = await buildSaxoAdapter({ userId, portfolioId, envOverride: env });
  const [bal, pos, hold] = await Promise.all([
    adapter.getBalance(),
    adapter.getPositions(),
    db.from("holdings").select("symbol, quantity, avg_cost").eq("portfolio_id", portfolioId),
  ]);
  const localPositions = (hold.data ?? []).map((h) => ({
    symbol: h.symbol, quantity: Number(h.quantity), avgPrice: Number(h.avg_cost),
  }));
  const cashDrift = Math.abs(bal.cash - Number(p.data.current_cash ?? 0));
  const symDrift = detectPositionDrift(pos, localPositions);
  const drift = cashDrift > 1 || symDrift.length > 0;
  await db.from("live_reconciliation").insert({
    portfolio_id: portfolioId, user_id: userId,
    broker_cash: bal.cash,
    broker_positions: pos as never,
    local_cash: Number(p.data.current_cash ?? 0),
    local_positions: localPositions as never,
    drift_flag: drift,
    drift_notes: drift
      ? `cash Δ=${cashDrift.toFixed(2)}; positions Δ=${symDrift.join(", ") || "none"}`
      : null,
  });

  let orderRecon: Awaited<ReturnType<typeof import("@/lib/order-reconciliation.server").reconcileOrderStatusesForPortfolio>> | null = null;
  try {
    const { reconcileOrderStatusesForPortfolio } = await import("@/lib/order-reconciliation.server");
    orderRecon = await reconcileOrderStatusesForPortfolio({
      portfolioId, userId, adapter, lookbackHours: 72,
    });
  } catch (e) {
    console.warn("order-status reconciliation failed", e);
  }

  return { drift, cashDrift, positionDrift: symDrift, orderRecon };
}
