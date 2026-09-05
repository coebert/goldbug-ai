// Server-only helper: notify the owner when the broker refuses an order for a
// permanent, account-level reason (Saxo suitability / appropriateness, missing
// permission, instrument not tradable).
//
// Writes an in-app notification (category=`broker_block`) plus a browser push,
// and is de-duplicated per symbol per day so an hourly run that keeps hitting
// the same wall does not spam. The detailed audit trail lives in
// `broker_block_events` (see broker-instrument-blocks.server.ts).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPushToUser } from "@/lib/push.server";
import { recommendedActionFor, type BrokerBlockReason } from "@/lib/broker-instrument-blocks";

const REASON_LABEL: Record<string, string> = {
  suitability: "suitability test required",
  not_tradable: "not tradable on this account",
  not_permitted: "trading permission missing",
  kid_unavailable: "no Key Information Document (retail clients cannot buy it)",
};

export interface BrokerBlockNotifyInput {
  userId: string;
  portfolioId?: string | null;
  broker: string;
  symbol: string;
  symbolKey: string;
  reason: BrokerBlockReason | string;
  detail: string | null;
  rejectReason: string | null;
  orderId?: string | null;
  firstBlock: boolean;
  hitCount: number;
}

export function notifyBrokerBlock(input: BrokerBlockNotifyInput): void {
  void (async () => {
    try {
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);

      // One notification per symbol per day.
      const existing = await supabaseAdmin
        .from("notifications")
        .select("id")
        .eq("user_id", input.userId)
        .eq("category", "broker_block")
        .gte("created_at", dayStart.toISOString())
        .contains("details", { symbol_key: input.symbolKey })
        .limit(1)
        .maybeSingle();
      if (existing.data) return;

      const label = REASON_LABEL[input.reason] ?? String(input.reason);
      const action = recommendedActionFor(input.reason);
      const title = `${input.symbol} blocked by ${input.broker.toUpperCase()} — ${label}`;
      const body = `${input.detail ?? "The broker refused the order at account level."} Next: ${action}`;
      const url = "/broker-blocks";

      await supabaseAdmin.from("notifications").insert({
        user_id: input.userId,
        category: "broker_block",
        severity: input.firstBlock ? "warning" : "info",
        title,
        body,
        portfolio_id: input.portfolioId ?? null,
        details: {
          broker: input.broker,
          symbol: input.symbol,
          symbol_key: input.symbolKey,
          reason: input.reason,
          detail: input.detail,
          reject_reason: input.rejectReason,
          order_id: input.orderId ?? null,
          recommended_action: action,
          hit_count: input.hitCount,
          url,
        },
      });

      await sendPushToUser(input.userId, {
        title,
        body: `Next: ${action}`,
        url,
        tag: `broker-block-${input.symbolKey}`,
      });
    } catch (err) {
      console.error("notifyBrokerBlock failed", err);
    }
  })();
}
