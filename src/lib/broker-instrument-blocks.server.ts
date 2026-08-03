import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  blockSymbolKey,
  classifyBrokerBlock,
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

  if (existing.data?.id) {
    await supabaseAdmin
      .from("broker_instrument_blocks")
      .update({
        hit_count: Number(existing.data.hit_count ?? 0) + 1,
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

  console.info(
    `[broker-blocks] ${broker} blocked ${args.symbol} (${cls.reason}): ${cls.detail}`,
  );
  return { blocked: true, reason: cls.reason };
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

/** Clear an active block so the symbol re-enters the live universe. */
export async function clearBrokerBlock(args: {
  userId: string;
  symbolKey: string;
  broker?: string;
}): Promise<boolean> {
  const key = blockSymbolKey(args.symbolKey);
  const { error } = await supabaseAdmin
    .from("broker_instrument_blocks")
    .update({ cleared_at: new Date().toISOString() })
    .eq("user_id", args.userId)
    .eq("broker", args.broker ?? "saxo")
    .eq("symbol_key", key)
    .is("cleared_at", null);
  if (error) {
    console.warn("[broker-blocks] clear failed:", error.message);
    return false;
  }
  return true;
}
