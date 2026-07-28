// Server-only helper: notify the portfolio owner when a trade fills.
//
// Called after every successful `live_fills` insert (live-executor immediate
// path + order reconciler's three fill paths). Writes an in-app notification
// row (category=`trade_filled`) and sends a browser push to every registered
// device. Idempotent per order_id, so double-invocation from
// reconciler-vs-executor overlap does not spam.
//
// Fire-and-forget: never let a notification failure disturb the caller.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPushToUser } from "@/lib/push.server";

export interface TradeFillNotifyInput {
  userId: string;
  portfolioId: string;
  orderId: string;
  symbol: string;
  side: string; // "buy" | "sell"
  quantity: number;
  fillPrice: number | null;
  currency: string | null;
  source: string; // "live_executor" | "reconciler:position" | "reconciler:presumed" | "reconciler:history"
}

function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? n.toLocaleString("en-GB") : n.toLocaleString("en-GB", { maximumFractionDigits: 4 });
}

function fmtPrice(n: number | null, ccy: string | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  const cur = (ccy || "GBP").toUpperCase();
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: cur, maximumFractionDigits: 4 }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
}

export function notifyTradeFilled(input: TradeFillNotifyInput): void {
  void (async () => {
    try {
      // Idempotency: one notification per order_id.
      const existing = await supabaseAdmin
        .from("notifications")
        .select("id")
        .eq("user_id", input.userId)
        .eq("category", "trade_filled")
        .contains("details", { order_id: input.orderId })
        .limit(1)
        .maybeSingle();
      if (existing.data) return;

      const sideUpper = input.side.toUpperCase();
      const priceStr = fmtPrice(input.fillPrice, input.currency);
      const title = `Trade filled: ${sideUpper} ${fmtQty(input.quantity)} ${input.symbol}`;
      const body = priceStr ? `Filled at ${priceStr}` : `Order ${input.orderId.slice(0, 8)} filled`;

      await supabaseAdmin.from("notifications").insert({
        user_id: input.userId,
        category: "trade_filled",
        severity: "info",
        title,
        body,
        portfolio_id: input.portfolioId,
        details: {
          order_id: input.orderId,
          symbol: input.symbol,
          side: input.side,
          quantity: input.quantity,
          fill_price: input.fillPrice,
          currency: input.currency,
          source: input.source,
        },
      });

      await sendPushToUser(input.userId, {
        title,
        body,
        url: `/portfolio/${input.portfolioId}`,
        tag: `trade-${input.orderId}`,
      });
    } catch (err) {
      console.error("notifyTradeFilled failed", err);
    }
  })();
}
