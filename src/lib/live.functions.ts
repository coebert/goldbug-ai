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
    // Pick up any external deposits/withdrawals into Saxo before returning the
    // broker snapshot so the UI immediately reflects the newly-available cash.
    const { syncLiveCashFromBroker } = await import("@/lib/live-cash-sync.server");
    const sync = await syncLiveCashFromBroker(data.portfolioId);
    const env = own.data.mode === "live_prod" ? "live" : "sim";
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const adapter = await buildSaxoAdapter({ userId: context.userId, portfolioId: data.portfolioId, envOverride: env });
    const bal = await adapter.getBalance();
    const pos = await adapter.getPositions();
    return { balance: bal, positions: pos, sync };
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

    const [orders, fills, recon, lastSync] = await Promise.all([
      supabase.from("live_orders").select("*")
        .eq("portfolio_id", data.portfolioId).order("created_at", { ascending: false }).limit(50),
      supabase.from("live_fills").select("*")
        .eq("portfolio_id", data.portfolioId).order("filled_at", { ascending: false }).limit(50),
      supabase.from("live_reconciliation").select("*")
        .eq("portfolio_id", data.portfolioId).order("as_of", { ascending: false }).limit(5),
      supabase.from("live_broker_log")
        .select("created_at, status, request, response, error")
        .eq("portfolio_id", data.portfolioId)
        .eq("method", "CASH_SYNC")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    return {
      portfolio: p.data,
      orders: orders.data ?? [],
      fills: fills.data ?? [],
      reconciliation: recon.data ?? [],
      lastCashSync: lastSync.data ?? null,
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

/** Fetch Saxo order statuses for every open live order and update fills. */
export const reconcileOrders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { portfolioId: string; lookbackHours?: number }) =>
    z.object({
      portfolioId: z.string().uuid(),
      lookbackHours: z.number().int().positive().max(24 * 14).optional(),
    }).parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const p = await supabase.from("portfolios").select("id, user_id, mode")
      .eq("id", data.portfolioId).maybeSingle();
    if (p.error || !p.data || p.data.user_id !== userId) throw new Error("Portfolio not found");
    if (p.data.mode !== "live_sim" && p.data.mode !== "live_prod") {
      return { skipped: true, reason: "not live" as const };
    }
    const env = p.data.mode === "live_prod" ? "live" : "sim";
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const { reconcileOrderStatusesForPortfolio } = await import("@/lib/order-reconciliation.server");
    const adapter = await buildSaxoAdapter({
      userId, portfolioId: data.portfolioId, envOverride: env,
    });
    return reconcileOrderStatusesForPortfolio({
      portfolioId: data.portfolioId,
      userId,
      adapter,
      lookbackHours: data.lookbackHours,
    });
  });

// Shared reconciliation core (also called from the cron route).
export async function runReconciliation(userId: string, portfolioId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Sync external deposits/withdrawals first so `current_cash` reflects the
  // account as of right now before we snapshot broker vs local for drift.
  const { syncLiveCashFromBroker } = await import("@/lib/live-cash-sync.server");
  await syncLiveCashFromBroker(portfolioId);
  // Then overwrite local holdings + today's equity snapshot from broker so
  // any phantom positions left over from rejected/errored Saxo orders are
  // wiped out. Broker is the source of truth for live portfolios.
  const { reconcileLiveHoldingsFromBroker } = await import(
    "@/lib/live-holdings-sync.server"
  );
  await reconcileLiveHoldingsFromBroker(portfolioId);
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

  // Also refresh per-order broker statuses so filled/rejected trades are
  // reflected in live_orders + live_fills without waiting for a manual click.
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

/**
 * Dashboard alert: detect when a live portfolio has completed several run
 * windows without producing a single successful fill, and explain why.
 *
 * A "run window" is one recorded decision row (hourly-run inserts one per tick).
 * We look at the last N runs, count fills recorded during that timespan, and
 * classify the dominant blocker from the most recent decision's guardrail
 * metadata and any live_orders written since then.
 */
export const getLiveTradeAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { portfolioId: string; windowRuns?: number }) =>
    z.object({
      portfolioId: z.string().uuid(),
      windowRuns: z.number().int().min(1).max(50).default(5),
    }).parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const p = await supabase.from("portfolios")
      .select("id, user_id, mode, live_paused, current_cash, currency")
      .eq("id", data.portfolioId).maybeSingle();
    if (p.error || !p.data || p.data.user_id !== userId) throw new Error("Portfolio not found");

    const mode = p.data.mode;
    if (mode !== "live_sim" && mode !== "live_prod") {
      return { active: false, reason: "not_live" as const };
    }

    const decs = await supabase.from("decisions")
      .select("id, run_date, briefing, raw, created_at")
      .eq("portfolio_id", data.portfolioId)
      .order("created_at", { ascending: false })
      .limit(data.windowRuns);
    const runs = decs.data ?? [];
    if (runs.length < 2) {
      // Not enough history to judge — don't nag the user right after activation.
      return { active: false, reason: "insufficient_runs" as const, runsSeen: runs.length };
    }

    const windowStart = runs[runs.length - 1].created_at;

    const [fillsRes, ordersRes] = await Promise.all([
      supabase.from("live_fills").select("id, filled_at")
        .eq("portfolio_id", data.portfolioId)
        .gte("filled_at", windowStart),
      supabase.from("live_orders").select("id, status, reject_reason, created_at, symbol")
        .eq("portfolio_id", data.portfolioId)
        .gte("created_at", windowStart)
        .order("created_at", { ascending: false }),
    ]);
    const fills = fillsRes.data ?? [];
    const orders = ordersRes.data ?? [];

    if (fills.length > 0) {
      return { active: false, reason: "has_fills" as const, fills: fills.length, runsSeen: runs.length };
    }

    // No successful fills in the window — classify why.
    type Latest = { raw?: { orders?: unknown[]; guardrails?: Record<string, unknown> }; briefing?: string | null };
    const latest = runs[0] as unknown as Latest;
    const guard = (latest.raw?.guardrails ?? {}) as Record<string, unknown>;
    const afford = (guard.affordability ?? {}) as {
      per_symbol_budget?: number;
      min_trade_value?: number;
      universe_total?: number;
      candidates_kept?: number;
      dropped_for_cash?: string[];
      broker_blocked?: string[];
      notes?: string[];
    };
    const intendedOrders = Array.isArray(latest.raw?.orders) ? latest.raw!.orders! : [];
    const briefing = String(latest.briefing ?? "");

    let category:
      | "circuit_breaker"
      | "paused"
      | "no_affordable"
      | "broker_blocked"
      | "no_ai_orders"
      | "orders_never_reached_broker"
      | "orders_rejected"
      | "unknown" = "unknown";
    let title = "No successful trades in the last run window";
    let detail = "";
    const hint: string[] = [];

    if (p.data.live_paused) {
      category = "paused";
      title = "Live trading is paused";
      detail = "Runs continue but no orders are sent to the broker while paused. Resume live trading to allow new fills.";
    } else if (/circuit breaker/i.test(briefing)) {
      category = "circuit_breaker";
      title = "Circuit breaker active — no new AI orders";
      detail = briefing || "The engine auto-paused new buys after a drawdown/volatility trigger. Stops still enforced.";
    } else if ((afford.candidates_kept ?? 0) === 0 && (afford.universe_total ?? 0) > 0) {
      const blocked = afford.broker_blocked ?? [];
      const dropped = afford.dropped_for_cash ?? [];
      if (blocked.length && dropped.length === 0) {
        category = "broker_blocked";
        title = "Every candidate was filtered as un-tradeable at the broker";
        detail = `${blocked.length} symbol${blocked.length === 1 ? "" : "s"} blocked (e.g. ${blocked.slice(0, 4).join(", ")}). Add broker-tradeable tickers to the universe.`;
      } else {
        category = "no_affordable";
        title = "No affordable instruments for this cash balance";
        const budget = afford.per_symbol_budget;
        const minT = afford.min_trade_value;
        detail = `Per-symbol budget ${typeof budget === "number" ? `${p.data.currency} ${budget.toFixed(2)}` : "n/a"}${typeof minT === "number" ? `, min trade ${p.data.currency} ${minT.toFixed(2)}` : ""} — no whole share of any candidate fits. Add funds, widen the per-symbol cap, or lower min_trade_value.`;
        if (dropped.length) hint.push(`Recently dropped for cash: ${dropped.slice(0, 6).join(", ")}`);
      }
    } else if (intendedOrders.length === 0) {
      category = "no_ai_orders";
      title = "The AI proposed no trades in the last run window";
      detail = "Every recent run returned an empty order list — usually low-conviction signals or all guardrails triggered hold. This is normal in quiet markets.";
    } else if (orders.length === 0) {
      category = "orders_never_reached_broker";
      title = "AI proposed trades but none reached the broker";
      detail = "Order routing produced no live_orders rows — check Saxo OAuth status and broker connectivity.";
    } else {
      // Aggregate rejection reasons.
      const bad = orders.filter((o) => ["rejected", "errored", "cancelled"].includes(o.status));
      const reasons = Array.from(new Set(bad.map((o) => o.reject_reason).filter(Boolean))) as string[];
      category = "orders_rejected";
      title = `${bad.length} of ${orders.length} broker order${orders.length === 1 ? "" : "s"} did not fill`;
      detail = reasons.length
        ? `Broker reasons: ${reasons.slice(0, 3).join(" · ")}`
        : "Orders were submitted but none returned a fill. Open a trade row for its timeline.";
    }

    return {
      active: true,
      category,
      title,
      detail,
      hint,
      runsSeen: runs.length,
      windowStart,
      ordersInWindow: orders.length,
      intendedOrdersLastRun: intendedOrders.length,
      affordability: afford,
      reason: "no_fills" as const,
    };
  });
