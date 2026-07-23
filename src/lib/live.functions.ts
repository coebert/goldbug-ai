// Server functions for live trading control: activate/deactivate, kill-switch,
// balance sync, ping, and manual reconciliation. All require an authenticated user.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const activateSchema = z.object({
  portfolioId: z.string().uuid(),
  targetEnv: z.enum(["sim", "prod"]),
  useBrokerBalance: z.boolean().default(true),
  acknowledgeRisk: z.literal(true),
});

/** Activate live trading on a portfolio. Requires ping + optional balance read. */
export const activateLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.infer<typeof activateSchema>) => activateSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const own = await supabase.from("portfolios").select("id, user_id, mode")
      .eq("id", data.portfolioId).maybeSingle();
    if (own.error || !own.data || own.data.user_id !== userId) throw new Error("Portfolio not found");

    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const adapter = buildSaxoAdapter({
      userId, portfolioId: data.portfolioId,
      envOverride: data.targetEnv === "prod" ? "live" : "sim",
    });
    const ping = await adapter.ping();
    if (!ping.ok) throw new Error(`Broker ping failed: ${ping.reason ?? "unknown"}`);

    let starting: number | undefined;
    let brokerAccountId = ping.accountId;
    if (data.useBrokerBalance) {
      const bal = await adapter.getBalance();
      starting = bal.cash;
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch: Record<string, unknown> = {
      mode: data.targetEnv === "prod" ? "live_prod" : "live_sim",
      broker: "saxo",
      broker_account_id: brokerAccountId ?? null,
      live_paused: false,
      live_activated_at: new Date().toISOString(),
    };
    if (starting != null && starting > 0) {
      patch.starting_cash = starting;
      patch.current_cash = starting;
    }
    const upd = await supabaseAdmin.from("portfolios").update(patch).eq("id", data.portfolioId);
    if (upd.error) throw new Error(upd.error.message);
    return { ok: true, ping, startingCash: starting };
  });

export const deactivateLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { portfolioId: string }) =>
    z.object({ portfolioId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const own = await context.supabase.from("portfolios")
      .select("id, user_id").eq("id", data.portfolioId).maybeSingle();
    if (own.error || !own.data || own.data.user_id !== context.userId) throw new Error("Portfolio not found");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const upd = await supabaseAdmin.from("portfolios").update({
      mode: "paper", live_paused: false,
    }).eq("id", data.portfolioId);
    if (upd.error) throw new Error(upd.error.message);
    return { ok: true };
  });

export const pauseLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { portfolioId: string; paused: boolean }) =>
    z.object({ portfolioId: z.string().uuid(), paused: z.boolean() }).parse(data))
  .handler(async ({ data, context }) => {
    const own = await context.supabase.from("portfolios")
      .select("id, user_id").eq("id", data.portfolioId).maybeSingle();
    if (own.error || !own.data || own.data.user_id !== context.userId) throw new Error("Portfolio not found");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const upd = await supabaseAdmin.from("portfolios").update({ live_paused: data.paused })
      .eq("id", data.portfolioId);
    if (upd.error) throw new Error(upd.error.message);
    return { ok: true, paused: data.paused };
  });

/** Global kill-switch — pause every live portfolio owned by the caller. */
export const killAllLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const upd = await supabaseAdmin.from("portfolios")
      .update({ live_paused: true })
      .in("mode", ["live_sim", "live_prod"])
      .eq("user_id", context.userId);
    if (upd.error) throw new Error(upd.error.message);
    return { ok: true };
  });

export const pingBroker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { portfolioId: string; env?: "sim" | "live" }) =>
    z.object({ portfolioId: z.string().uuid(), env: z.enum(["sim", "live"]).optional() }).parse(data))
  .handler(async ({ data, context }) => {
    const own = await context.supabase.from("portfolios")
      .select("id, user_id, mode").eq("id", data.portfolioId).maybeSingle();
    if (own.error || !own.data || own.data.user_id !== context.userId) throw new Error("Portfolio not found");
    const env = data.env ?? (own.data.mode === "live_prod" ? "live" : "sim");
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const adapter = buildSaxoAdapter({ userId: context.userId, portfolioId: data.portfolioId, envOverride: env });
    return adapter.ping();
  });

export const syncBrokerBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { portfolioId: string }) =>
    z.object({ portfolioId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const own = await context.supabase.from("portfolios")
      .select("id, user_id, mode").eq("id", data.portfolioId).maybeSingle();
    if (own.error || !own.data || own.data.user_id !== context.userId) throw new Error("Portfolio not found");
    const env = own.data.mode === "live_prod" ? "live" : "sim";
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const adapter = buildSaxoAdapter({ userId: context.userId, portfolioId: data.portfolioId, envOverride: env });
    const bal = await adapter.getBalance();
    const pos = await adapter.getPositions();
    return { balance: bal, positions: pos };
  });

export const getLiveStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { portfolioId: string }) =>
    z.object({ portfolioId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const p = await supabase.from("portfolios")
      .select("id, user_id, mode, broker, broker_account_id, live_paused, live_activated_at")
      .eq("id", data.portfolioId).maybeSingle();
    if (p.error || !p.data || p.data.user_id !== userId) throw new Error("Portfolio not found");

    const [orders, fills, recon] = await Promise.all([
      supabase.from("live_orders").select("*")
        .eq("portfolio_id", data.portfolioId).order("created_at", { ascending: false }).limit(50),
      supabase.from("live_fills").select("*")
        .eq("portfolio_id", data.portfolioId).order("filled_at", { ascending: false }).limit(50),
      supabase.from("live_reconciliation").select("*")
        .eq("portfolio_id", data.portfolioId).order("as_of", { ascending: false }).limit(5),
    ]);

    return {
      portfolio: p.data,
      orders: orders.data ?? [],
      fills: fills.data ?? [],
      reconciliation: recon.data ?? [],
      hasToken: !!process.env.SAXO_ACCESS_TOKEN,
      env: (process.env.SAXO_ENV as "sim" | "live" | undefined) ?? "sim",
    };
  });

/** Nightly reconciliation: pull broker cash+positions, snapshot vs local. */
export const reconcilePortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { portfolioId: string }) =>
    z.object({ portfolioId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    return runReconciliation(context.userId, data.portfolioId);
  });

// Shared reconciliation core (also called from the cron route).
export async function runReconciliation(userId: string, portfolioId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const p = await supabaseAdmin.from("portfolios")
    .select("id, user_id, mode, current_cash").eq("id", portfolioId).maybeSingle();
  if (p.error || !p.data) throw new Error("Portfolio not found");
  if (p.data.user_id !== userId) throw new Error("Not owned by caller");
  if (p.data.mode !== "live_sim" && p.data.mode !== "live_prod") {
    return { skipped: true, reason: "not live" };
  }
  const env = p.data.mode === "live_prod" ? "live" : "sim";
  const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
  const adapter = buildSaxoAdapter({ userId, portfolioId, envOverride: env });
  const [bal, pos, hold] = await Promise.all([
    adapter.getBalance(),
    adapter.getPositions(),
    supabaseAdmin.from("holdings").select("symbol, quantity, avg_price").eq("portfolio_id", portfolioId),
  ]);
  const localPositions = (hold.data ?? []).map((h) => ({
    symbol: h.symbol, quantity: Number(h.quantity), avgPrice: Number(h.avg_price),
  }));
  const cashDrift = Math.abs(bal.cash - Number(p.data.current_cash ?? 0));
  const symDrift = detectPositionDrift(pos, localPositions);
  const drift = cashDrift > 1 || symDrift.length > 0;
  await supabaseAdmin.from("live_reconciliation").insert({
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
  return { drift, cashDrift, positionDrift: symDrift };
}

function detectPositionDrift(
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
