// Server-only helper: alert the owner the moment the AI routes a trade to the
// broker — before we know whether it filled — so they can act on it.
//
// Writes an in-app notification (category=`trade_opened`) plus a browser push
// carrying the stock, the size (quantity + notional) and a short summary of
// the signals the AI acted on (pulled from `ai_decision_audit.market_inputs`
// / `rationale` for that order). Idempotent per order_id.
//
// Fire-and-forget: never let a notification failure disturb the caller.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPushToUser } from "@/lib/push.server";

export interface TradeOpenNotifyInput {
  userId: string;
  portfolioId: string;
  orderId: string;
  decisionId?: string | null;
  symbol: string;
  side: string; // "buy" | "sell"
  quantity: number;
  price: number | null;
  currency: string | null;
  status: string; // broker status: filled | submitted | working | ...
  orderType?: string | null;
  limitPrice?: number | null;
}

function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n)
    ? n.toLocaleString("en-GB")
    : n.toLocaleString("en-GB", { maximumFractionDigits: 4 });
}

function fmtMoney(n: number | null | undefined, ccy: string | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  const cur = (ccy || "GBP").toUpperCase();
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: cur,
      maximumFractionDigits: n >= 100 ? 2 : 4,
    }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
}

function pct(n: unknown, digits = 1): string | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Compact, human-readable list of the signals behind the trade. */
export function summariseSignals(marketInputs: unknown): string[] {
  const mi = (marketInputs ?? {}) as Record<string, unknown>;
  const f = (mi["features"] ?? {}) as Record<string, unknown>;
  const out: string[] = [];

  const c30 = pct(f["change30d"]);
  const c5 = pct(f["change5d"]);
  if (c30) out.push(`30d ${c30}`);
  if (c5) out.push(`5d ${c5}`);

  const rsi = num(f["rsi14"]);
  if (rsi != null) out.push(`RSI ${rsi.toFixed(0)}`);

  const macd = num(f["macd_hist"]);
  if (macd != null) out.push(`MACD ${macd >= 0 ? "+" : "−"}`);

  const rank = f["rank_info"] as Record<string, unknown> | null | undefined;
  const rankPos = rank ? num(rank["rank"]) : null;
  const universe = rank ? num(rank["universe_size"]) : null;
  if (rankPos != null) out.push(`rank ${rankPos}${universe != null ? `/${universe}` : ""}`);

  const news = num(f["news_score"]);
  if (news != null && Math.abs(news) >= 0.05) out.push(`news ${news >= 0 ? "+" : ""}${news.toFixed(2)}`);

  const breakout = f["breakout"] as Record<string, unknown> | null | undefined;
  if (breakout && breakout["actionable"] === true) out.push("breakout confirmed");

  const events = f["event_features"] as Record<string, unknown> | null | undefined;
  const kinds = events?.["top_kinds"];
  if (Array.isArray(kinds) && kinds.length > 0) out.push(`event: ${String(kinds[0]).replace(/_/g, " ")}`);

  const regime = mi["regime"] as Record<string, unknown> | null | undefined;
  const regimeLabel = regime ? (regime["label"] ?? regime["regime"] ?? regime["state"]) : null;
  if (typeof regimeLabel === "string" && regimeLabel) out.push(`regime ${regimeLabel}`);

  const sector = mi["sector"];
  if (typeof sector === "string" && sector) out.push(sector);

  return out;
}

/** Trim the engine's long bracketed rationale down to its leading sentence. */
export function shortRationale(rationale: string | null | undefined): string | null {
  if (!rationale) return null;
  const head = rationale.split(" [")[0]?.trim() ?? "";
  if (!head) return null;
  return head.length > 180 ? `${head.slice(0, 177)}…` : head;
}

export function notifyTradeOpened(input: TradeOpenNotifyInput): void {
  void (async () => {
    try {
      const existing = await supabaseAdmin
        .from("notifications")
        .select("id")
        .eq("user_id", input.userId)
        .eq("category", "trade_opened")
        .contains("details", { order_id: input.orderId })
        .limit(1)
        .maybeSingle();
      if (existing.data) return;

      // Signals behind the decision, if the audit row landed already.
      let signals: string[] = [];
      let reason: string | null = null;
      try {
        let q = supabaseAdmin
          .from("ai_decision_audit")
          .select("rationale, market_inputs, decided_at")
          .eq("portfolio_id", input.portfolioId)
          .eq("symbol", input.symbol.toUpperCase())
          .eq("action", input.side)
          .order("decided_at", { ascending: false })
          .limit(1);
        q = q.eq("order_id", input.orderId);
        let audit = await q.maybeSingle();
        if (!audit.data && input.decisionId) {
          audit = await supabaseAdmin
            .from("ai_decision_audit")
            .select("rationale, market_inputs, decided_at")
            .eq("decision_id", input.decisionId)
            .eq("symbol", input.symbol.toUpperCase())
            .eq("action", input.side)
            .order("decided_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        }
        if (audit.data) {
          signals = summariseSignals(audit.data.market_inputs);
          reason = shortRationale(audit.data.rationale);
        }
      } catch {
        /* signals are best-effort */
      }

      const sideUpper = input.side.toUpperCase();
      const opening = input.side.toLowerCase() === "buy";
      const priceRef = input.price ?? input.limitPrice ?? null;
      const priceStr = fmtMoney(priceRef, input.currency);
      const notionalStr =
        priceRef != null ? fmtMoney(input.quantity * priceRef, input.currency) : "";
      const qtyStr = fmtQty(input.quantity);

      const title = `AI ${opening ? "opened" : "closed"}: ${sideUpper} ${qtyStr} ${input.symbol}${
        notionalStr ? ` (${notionalStr})` : ""
      }`;

      const bodyLines = [
        `${sideUpper} ${qtyStr} ${input.symbol}${priceStr ? ` @ ${priceStr}` : ""}${
          notionalStr ? ` — ${notionalStr}` : ""
        }`,
        signals.length ? `Signals: ${signals.slice(0, 6).join(" · ")}` : null,
        reason,
        `Status: ${input.status}`,
      ].filter(Boolean) as string[];
      const body = bodyLines.join("\n");
      const url = `/trades?order=${encodeURIComponent(input.orderId)}`;

      await supabaseAdmin.from("notifications").insert({
        user_id: input.userId,
        category: "trade_opened",
        severity: "info",
        title,
        body,
        portfolio_id: input.portfolioId,
        details: {
          order_id: input.orderId,
          decision_id: input.decisionId ?? null,
          symbol: input.symbol,
          side: input.side,
          quantity: input.quantity,
          price: priceRef,
          notional: priceRef != null ? Number((input.quantity * priceRef).toFixed(2)) : null,
          currency: input.currency,
          status: input.status,
          order_type: input.orderType ?? null,
          signals,
          rationale: reason,
          url,
        },
      });

      await sendPushToUser(input.userId, {
        title,
        body,
        url,
        tag: `trade-open-${input.orderId}`,
        requireInteraction: true,
      });
    } catch (err) {
      console.error("notifyTradeOpened failed", err);
    }
  })();
}
