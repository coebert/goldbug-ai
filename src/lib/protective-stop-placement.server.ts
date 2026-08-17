import type { SaxoAdapter } from "./brokers/saxo.server";
import { asJson } from "@/lib/_server/db-json";
import { planProtectiveStop } from "./protective-stops";

/**
 * Rest a broker-side stop after a BUY fill is confirmed. This is shared by
 * immediate fills and every reconciliation path; most Saxo equity orders are
 * initially only `submitted`, so limiting stop placement to the immediate
 * response leaves positions unprotected.
 */
export async function placeProtectiveStopAfterBuyFill(args: {
  adapter: SaxoAdapter;
  portfolioId: string;
  userId: string;
  orderId: string;
  symbol: string;
  side: string;
  quantity: number;
  fillPrice: number;
  source: string;
}): Promise<void> {
  if (args.side.toLowerCase() !== "buy") return;
  const stop = planProtectiveStop({ side: "buy", fillPrice: args.fillPrice });
  const stopQty = Math.floor(args.quantity);
  if (!stop || stopQty < 1) return;

  const clientOrderId = `stop:${args.orderId}`.slice(0, 50);
  try {
    const stopRes = await args.adapter.placeOrder({
      symbol: args.symbol,
      side: stop.side,
      quantity: stopQty,
      orderType: "stop",
      stopPrice: stop.stopPrice,
      duration: "gtc",
      clientOrderId,
    });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: args.portfolioId,
      user_id: args.userId,
      broker: "saxo",
      env: args.adapter.env,
      method: "PROTECTIVE_STOP",
      path: "live_orders",
      status: null,
      request: asJson({
        source: args.source,
        orderId: args.orderId,
        symbol: args.symbol,
        quantity: stopQty,
        stopPrice: stop.stopPrice,
        stopPct: stop.stopPct,
        reason: stop.reason,
      }),
      response: asJson({ status: stopRes.status, brokerOrderId: stopRes.brokerOrderId }),
      error:
        stopRes.status === "rejected" || stopRes.status === "error"
          ? (stopRes.reason ?? stopRes.status)
          : null,
    });
  } catch (error) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: args.portfolioId,
      user_id: args.userId,
      broker: "saxo",
      env: args.adapter.env,
      method: "PROTECTIVE_STOP_FAILED",
      path: "live_orders",
      status: null,
      request: asJson({
        source: args.source,
        orderId: args.orderId,
        symbol: args.symbol,
        quantity: stopQty,
      }),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}