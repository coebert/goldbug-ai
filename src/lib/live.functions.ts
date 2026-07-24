// Server functions for live trading control: activate/deactivate, kill-switch,
// balance sync, ping, and manual reconciliation. All require an authenticated user.
//
// Every state transition (activate/deactivate/pause/resume/kill/resume-all) is
// idempotent and written to `live_broker_log` with a synthetic method so the
// full audit trail is queryable from one table.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const activateSchema = z.object({
  portfolioId: z.string().uuid(),
  targetEnv: z.enum(["sim", "prod"]),
  useBrokerBalance: z.boolean().default(true),
  acknowledgeRisk: z.literal(true),
  reason: z.string().max(500).optional(),
});

// Shared audit-log writer for kill-switch / pause / activate events.
// Uses supabaseAdmin so the entry persists even when the user's RLS view
// couldn't insert (e.g. bulk kill across many portfolios).
async function logAudit(params: {
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
    const adapter = await buildSaxoAdapter({
      userId, portfolioId: data.portfolioId,
      envOverride: data.targetEnv === "prod" ? "live" : "sim",
    });
    const ping = await adapter.ping();
    if (!ping.ok) {
      await logAudit({
        userId, portfolioId: data.portfolioId, action: "ACTIVATE",
        env: data.targetEnv, status: 502,
        request: { targetEnv: data.targetEnv, reason: data.reason },
        response: { ok: false }, error: `ping failed: ${ping.reason ?? "unknown"}`,
      });
      throw new Error(`Broker ping failed: ${ping.reason ?? "unknown"}`);
    }

    let starting: number | undefined;
    const brokerAccountId = ping.accountId;
    if (data.useBrokerBalance) {
      const bal = await adapter.getBalance();
      // Use the tradable cash Saxo reports (already max of settled + pending
      // deposits + SpendingPower). We adopt whatever the broker says — even a
      // small deposit like £100 — so the app never invents cash the account
      // doesn't hold.
      starting = bal.cashAvailable ?? bal.cash;
      if (!(starting > 0)) {
        await logAudit({
          userId, portfolioId: data.portfolioId, action: "ACTIVATE",
          env: data.targetEnv, status: 400,
          request: { targetEnv: data.targetEnv, reason: data.reason },
          response: { ok: false, brokerBalance: bal },
          error: "broker balance is zero",
        });
        throw new Error(
          `Saxo ${data.targetEnv.toUpperCase()} reports no available cash on this account. Deposit funds in Saxo and try again.`,
        );
      }
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch = {
      mode: (data.targetEnv === "prod" ? "live_prod" : "live_sim") as "live_prod" | "live_sim",
      broker: "saxo",
      broker_account_id: brokerAccountId ?? null,
      live_paused: false,
      live_activated_at: new Date().toISOString(),
      // Always overwrite starting/current cash when we successfully read the
      // broker so the portfolio can never claim more money than Saxo confirms.
      ...(starting != null
        ? { starting_cash: starting, current_cash: starting }
        : {}),
    };

    const upd = await supabaseAdmin.from("portfolios").update(patch).eq("id", data.portfolioId);
    if (upd.error) throw new Error(upd.error.message);
    await logAudit({
      userId, portfolioId: data.portfolioId, action: "ACTIVATE",
      env: data.targetEnv,
      request: { targetEnv: data.targetEnv, useBrokerBalance: data.useBrokerBalance, reason: data.reason ?? null },
      response: { mode: patch.mode, startingCash: starting ?? null, brokerAccountId },
    });
    return { ok: true, ping, startingCash: starting };
  });

const reasonInput = z.object({ portfolioId: z.string().uuid(), reason: z.string().max(500).optional() });

export const deactivateLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.infer<typeof reasonInput>) => reasonInput.parse(data))
  .handler(async ({ data, context }) => {
    const own = await context.supabase.from("portfolios")
      .select("id, user_id, mode").eq("id", data.portfolioId).maybeSingle();
    if (own.error || !own.data || own.data.user_id !== context.userId) throw new Error("Portfolio not found");
    const previousMode = own.data.mode;
    // Idempotent: already paper → log noop, don't rewrite.
    if (previousMode === "paper" || previousMode === "backtest") {
      await logAudit({
        userId: context.userId, portfolioId: data.portfolioId, action: "DEACTIVATE",
        request: { reason: data.reason ?? null },
        response: { noop: true, previousMode },
      });
      return { ok: true, changed: false };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const upd = await supabaseAdmin.from("portfolios").update({
      mode: "paper", live_paused: false,
    }).eq("id", data.portfolioId);
    if (upd.error) throw new Error(upd.error.message);
    await logAudit({
      userId: context.userId, portfolioId: data.portfolioId, action: "DEACTIVATE",
      request: { reason: data.reason ?? null },
      response: { previousMode, newMode: "paper" },
    });
    return { ok: true, changed: true };
  });

const pauseInput = z.object({
  portfolioId: z.string().uuid(),
  paused: z.boolean(),
  reason: z.string().max(500).optional(),
});

export const pauseLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.infer<typeof pauseInput>) => pauseInput.parse(data))
  .handler(async ({ data, context }) => {
    const own = await context.supabase.from("portfolios")
      .select("id, user_id, live_paused, mode").eq("id", data.portfolioId).maybeSingle();
    if (own.error || !own.data || own.data.user_id !== context.userId) throw new Error("Portfolio not found");
    const prevPaused = !!own.data.live_paused;
    // Idempotent: same state → skip write, still log the request for audit.
    if (prevPaused === data.paused) {
      await logAudit({
        userId: context.userId, portfolioId: data.portfolioId,
        action: data.paused ? "PAUSE" : "RESUME",
        request: { reason: data.reason ?? null },
        response: { noop: true, paused: prevPaused },
      });
      return { ok: true, paused: prevPaused, changed: false };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const upd = await supabaseAdmin.from("portfolios").update({ live_paused: data.paused })
      .eq("id", data.portfolioId);
    if (upd.error) throw new Error(upd.error.message);
    await logAudit({
      userId: context.userId, portfolioId: data.portfolioId,
      action: data.paused ? "PAUSE" : "RESUME",
      request: { reason: data.reason ?? null },
      response: { paused: data.paused, previously: prevPaused },
    });
    return { ok: true, paused: data.paused, changed: true };
  });

const bulkInput = z.object({ reason: z.string().max(500).optional() }).default({});

/**
 * Global kill-switch — pause every live portfolio owned by the caller.
 * Idempotent: repeated calls succeed and are logged with `updated=0`.
 */
export const killAllLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.infer<typeof bulkInput>) => bulkInput.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Fetch current state so idempotent repeats and audit deltas are accurate.
    const cur = await supabaseAdmin.from("portfolios")
      .select("id, live_paused, mode")
      .in("mode", ["live_sim", "live_prod"])
      .eq("user_id", context.userId);
    if (cur.error) throw new Error(cur.error.message);
    const rows = cur.data ?? [];
    const toPause = rows.filter((r) => !r.live_paused).map((r) => r.id);
    const alreadyPaused = rows.filter((r) => r.live_paused).map((r) => r.id);
    if (toPause.length > 0) {
      const upd = await supabaseAdmin.from("portfolios").update({ live_paused: true })
        .in("id", toPause);
      if (upd.error) throw new Error(upd.error.message);
    }
    await logAudit({
      userId: context.userId, action: "KILL_SWITCH",
      request: { reason: data.reason ?? null, requested: rows.length },
      response: {
        total_live: rows.length,
        updated: toPause.length,
        already_paused: alreadyPaused.length,
        paused_ids: toPause,
      },
    });
    return {
      ok: true,
      total: rows.length,
      updated: toPause.length,
      alreadyPaused: alreadyPaused.length,
    };
  });

/** Global resume — inverse of the kill-switch. Also idempotent and audited. */
export const resumeAllLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: z.infer<typeof bulkInput>) => bulkInput.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const cur = await supabaseAdmin.from("portfolios")
      .select("id, live_paused, mode")
      .in("mode", ["live_sim", "live_prod"])
      .eq("user_id", context.userId);
    if (cur.error) throw new Error(cur.error.message);
    const rows = cur.data ?? [];
    const toResume = rows.filter((r) => r.live_paused).map((r) => r.id);
    if (toResume.length > 0) {
      const upd = await supabaseAdmin.from("portfolios").update({ live_paused: false })
        .in("id", toResume);
      if (upd.error) throw new Error(upd.error.message);
    }
    await logAudit({
      userId: context.userId, action: "RESUME_ALL",
      request: { reason: data.reason ?? null },
      response: { total_live: rows.length, resumed: toResume.length, resumed_ids: toResume },
    });
    return { ok: true, total: rows.length, resumed: toResume.length };
  });

/** Fetch recent kill-switch / pause / resume audit entries for the caller. */
export const getAuditLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { portfolioId?: string; limit?: number }) =>
    z.object({ portfolioId: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).default(20) }).parse(data ?? {}))
  .handler(async ({ data, context }) => {
    let q = context.supabase.from("live_broker_log")
      .select("id, portfolio_id, created_at, method, request, response, status, error, env")
      .in("method", ["KILL_SWITCH", "RESUME_ALL", "PAUSE", "RESUME", "ACTIVATE", "DEACTIVATE"])
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.portfolioId) q = q.eq("portfolio_id", data.portfolioId);
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    return { entries: r.data ?? [] };
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
    const adapter = await buildSaxoAdapter({ userId: context.userId, portfolioId: data.portfolioId, envOverride: env });
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
    const adapter = await buildSaxoAdapter({ userId: context.userId, portfolioId: data.portfolioId, envOverride: env });
    const bal = await adapter.getBalance();
    const pos = await adapter.getPositions();
    return { balance: bal, positions: pos };
  });

/**
 * Preview the cash + position breakdown Saxo would use as the starting pot
 * for a new live portfolio. Does NOT touch any portfolio row — pure read.
 * Used by the "New portfolio" card before the user confirms real-money mode.
 */
export const previewBrokerBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { env: "sim" | "live" }) =>
    z.object({ env: z.enum(["sim", "live"]) }).parse(data))
  .handler(async ({ data, context }) => {
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const adapter = await buildSaxoAdapter({
      userId: context.userId, portfolioId: null, envOverride: data.env,
    });
    const ping = await adapter.ping();
    if (!ping.ok) throw new Error(`Broker ping failed: ${ping.reason ?? "unknown"}`);
    const [bal, pos] = await Promise.all([adapter.getBalance(), adapter.getPositions()]);
    const positionsValue = pos.reduce(
      (s, p) => s + Number(p.marketPrice ?? 0) * Number(p.quantity ?? 0),
      0,
    );
    return {
      env: data.env,
      accountId: ping.accountId ?? null,
      currency: bal.currency,
      cash: bal.cash,
      cashAvailable: bal.cashAvailable ?? null,
      transactionsNotBooked: bal.transactionsNotBooked ?? null,
      reservedCash: bal.reservedCash ?? null,
      unrealizedPnl: bal.unrealizedPnl ?? null,
      positionsValue,
      totalValue: bal.totalValue,
      positionsCount: pos.length,
      fetchedAt: new Date().toISOString(),
    };
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
  const adapter = await buildSaxoAdapter({ userId, portfolioId, envOverride: env });
  const [bal, pos, hold] = await Promise.all([
    adapter.getBalance(),
    adapter.getPositions(),
    supabaseAdmin.from("holdings").select("symbol, quantity, avg_cost").eq("portfolio_id", portfolioId),
  ]);
  const localPositions = (hold.data ?? []).map((h) => ({
    symbol: h.symbol, quantity: Number(h.quantity), avgPrice: Number(h.avg_cost),
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

// ─── Saxo OAuth (auto-refresh) ──────────────────────────────────────────────

const saxoEnvSchema = z.object({ env: z.enum(["sim", "live"]) });

/** Return the URL the user should visit to grant Saxo access. */
export const startSaxoOAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: z.infer<typeof saxoEnvSchema>) => saxoEnvSchema.parse(d))
  .handler(async ({ data }) => {
    const { getAuthorizeUrl, redirectUri } = await import("@/lib/brokers/saxo-oauth.server");
    return { url: getAuthorizeUrl(data.env), redirectUri: redirectUri() };
  });

/** Read current Saxo OAuth token status for both envs. */
export const getSaxoOAuthStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { getOAuthStatus } = await import("@/lib/brokers/saxo-oauth.server");
    const [sim, live] = await Promise.all([getOAuthStatus("sim"), getOAuthStatus("live")]);
    return { sim, live };
  });
