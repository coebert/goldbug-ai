import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  blockSymbolKey,
  classifyBrokerBlock,
  recommendedActionFor,
  type BrokerBlockReason,
} from "./broker-instrument-blocks";

/**
 * Persistence layer for learned broker instrument blocks. See
 * ./broker-instrument-blocks.ts for the classification rules.
 */

export type ActiveBlock = {
  symbol: string;
  symbolKey: string;
  reason: BrokerBlockReason | string;
  detail: string | null;
  hitCount: number;
  lastSeenAt: string;
};

/** Record (or bump) a block if the rejection is a permanent account-level one. */
export async function recordBrokerRejection(args: {
  userId: string;
  portfolioId?: string | null;
  broker?: string;
  symbol: string;
  rejectReason: string | null | undefined;
  errorCode?: string | null;
  orderId?: string | null;
  side?: string | null;
  quantity?: number | null;
}): Promise<{ blocked: boolean; reason: BrokerBlockReason | null }> {
  const cls = classifyBrokerBlock(args.rejectReason, args.errorCode);
  if (!cls.block || !cls.reason) return { blocked: false, reason: null };

  const broker = args.broker ?? "saxo";
  const symbolKey = blockSymbolKey(args.symbol);
  const nowIso = new Date().toISOString();

  const existing = await supabaseAdmin
    .from("broker_instrument_blocks")
    .select("id, hit_count")
    .eq("user_id", args.userId)
    .eq("broker", broker)
    .eq("symbol_key", symbolKey)
    .maybeSingle();

  const firstBlock = !existing.data?.id;
  const hitCount = firstBlock ? 1 : Number(existing.data?.hit_count ?? 0) + 1;

  if (existing.data?.id) {
    await supabaseAdmin
      .from("broker_instrument_blocks")
      .update({
        hit_count: hitCount,
        last_seen_at: nowIso,
        cleared_at: null,
        reason: cls.reason,
        detail: cls.detail,
        reject_reason: (args.rejectReason ?? "").slice(0, 500),
        symbol: args.symbol,
        portfolio_id: args.portfolioId ?? null,
      })
      .eq("id", existing.data.id);
  } else {
    await supabaseAdmin.from("broker_instrument_blocks").insert({
      user_id: args.userId,
      portfolio_id: args.portfolioId ?? null,
      broker,
      symbol: args.symbol,
      symbol_key: symbolKey,
      reason: cls.reason,
      detail: cls.detail,
      reject_reason: (args.rejectReason ?? "").slice(0, 500),
      last_seen_at: nowIso,
    });
  }

  const recommendedAction = recommendedActionFor(cls.reason);

  // Detailed, append-only audit trail: one row per rejection occurrence.
  const audit = await supabaseAdmin.from("broker_block_events").insert({
    user_id: args.userId,
    portfolio_id: args.portfolioId ?? null,
    broker,
    symbol: args.symbol,
    symbol_key: symbolKey,
    reason: cls.reason,
    detail: cls.detail,
    reject_reason: (args.rejectReason ?? "").slice(0, 1000),
    error_code: args.errorCode ?? null,
    order_id: args.orderId ?? null,
    side: args.side ?? null,
    quantity: args.quantity ?? null,
    recommended_action: recommendedAction,
    first_block: firstBlock,
    hit_count: hitCount,
  });
  if (audit.error) {
    console.warn("[broker-blocks] audit insert failed:", audit.error.message);
  }

  const { notifyBrokerBlock } = await import("./broker-block-notify.server");
  notifyBrokerBlock({
    userId: args.userId,
    portfolioId: args.portfolioId ?? null,
    broker,
    symbol: args.symbol,
    symbolKey,
    reason: cls.reason,
    detail: cls.detail,
    rejectReason: args.rejectReason ?? null,
    orderId: args.orderId ?? null,
    firstBlock,
    hitCount,
  });

  console.info(
    `[broker-blocks] ${broker} blocked ${args.symbol} (${cls.reason}): ${cls.detail} — ${recommendedAction}`,
  );
  return { blocked: true, reason: cls.reason };
}

export type BrokerBlockEvent = {
  id: string;
  createdAt: string;
  broker: string;
  symbol: string;
  symbolKey: string;
  reason: string;
  detail: string | null;
  rejectReason: string | null;
  errorCode: string | null;
  orderId: string | null;
  side: string | null;
  quantity: number | null;
  recommendedAction: string;
  firstBlock: boolean;
  hitCount: number;
};

/** Most recent rejection events (audit log) for a user. */
export async function loadBrokerBlockEvents(
  userId: string,
  limit = 50,
): Promise<BrokerBlockEvent[]> {
  const { data, error } = await supabaseAdmin
    .from("broker_block_events")
    .select(
      "id, created_at, broker, symbol, symbol_key, reason, detail, reject_reason, error_code, order_id, side, quantity, recommended_action, first_block, hit_count",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) {
    console.warn("[broker-blocks] event load failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: r.id as string,
    createdAt: r.created_at as string,
    broker: r.broker as string,
    symbol: r.symbol as string,
    symbolKey: r.symbol_key as string,
    reason: r.reason as string,
    detail: (r.detail as string | null) ?? null,
    rejectReason: (r.reject_reason as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    orderId: (r.order_id as string | null) ?? null,
    side: (r.side as string | null) ?? null,
    quantity: r.quantity == null ? null : Number(r.quantity),
    recommendedAction: r.recommended_action as string,
    firstBlock: Boolean(r.first_block),
    hitCount: Number(r.hit_count ?? 1),
  }));
}

/** All active (not cleared) blocks for a user. */
export async function loadActiveBrokerBlocks(
  userId: string,
  broker = "saxo",
): Promise<ActiveBlock[]> {
  const { data, error } = await supabaseAdmin
    .from("broker_instrument_blocks")
    .select("symbol, symbol_key, reason, detail, hit_count, last_seen_at")
    .eq("user_id", userId)
    .eq("broker", broker)
    .is("cleared_at", null);
  if (error) {
    console.warn("[broker-blocks] load failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    symbol: r.symbol as string,
    symbolKey: r.symbol_key as string,
    reason: r.reason as string,
    detail: (r.detail as string | null) ?? null,
    hitCount: Number(r.hit_count ?? 1),
    lastSeenAt: r.last_seen_at as string,
  }));
}

/** Look up a single active block row (ownership check for clear flows). */
export async function findActiveBrokerBlock(args: {
  userId: string;
  symbolKey: string;
  broker?: string;
}): Promise<{ symbol: string; symbolKey: string; ownerId: string } | null> {
  const key = blockSymbolKey(args.symbolKey);
  const { data, error } = await supabaseAdmin
    .from("broker_instrument_blocks")
    .select("symbol, symbol_key, user_id")
    .eq("user_id", args.userId)
    .eq("broker", args.broker ?? "saxo")
    .eq("symbol_key", key)
    .is("cleared_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return {
    symbol: data.symbol as string,
    symbolKey: data.symbol_key as string,
    ownerId: data.user_id as string,
  };
}

/**
 * Clear an active block so the symbol re-enters the live universe.
 * Returns the number of rows actually cleared (0 when nothing matched), so
 * callers can distinguish "unblocked" from "there was nothing to unblock".
 */
export async function clearBrokerBlock(args: {
  userId: string;
  symbolKey: string;
  broker?: string;
}): Promise<number> {
  const key = blockSymbolKey(args.symbolKey);
  const { data, error } = await supabaseAdmin
    .from("broker_instrument_blocks")
    .update({ cleared_at: new Date().toISOString() })
    .eq("user_id", args.userId)
    .eq("broker", args.broker ?? "saxo")
    .eq("symbol_key", key)
    .is("cleared_at", null)
    .select("id");
  if (error) {
    console.warn("[broker-blocks] clear failed:", error.message);
    return 0;
  }
  return data?.length ?? 0;
}

