// Fires an operator alert when the fear index crosses an alert threshold and
// changes trading behaviour (blocked buys or resized buys).
//
// Delivery mirrors the other trading notifiers: in-app notification row +
// web push + optional webhook, with a cool-down enforced from the previous
// notification's created_at so no extra table is needed. Fire-and-forget so
// it never disturbs the trading tick.
//
//   FEAR_ALERT_WEBHOOK_URL    optional; falls back to PRECHECK_ALERT_WEBHOOK_URL
//   FEAR_ALERT_WEBHOOK_TOKEN  optional; falls back to PRECHECK_ALERT_WEBHOOK_TOKEN

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPushToUser } from "@/lib/push.server";
import { evaluateFearAlert, FEAR_ALERT_THRESHOLDS } from "@/lib/fear-index-alert";

const COOLDOWN_HOURS = 6;

export function maybeNotifyFearIndex(params: {
  portfolioId: string;
  userId: string | null;
  fearIndex: {
    score: number;
    label: string;
    sizeMultiplier: number;
    blockNewBuys: boolean;
    reason?: string | null;
  };
  orders: Array<{
    symbol: string;
    side: string;
    value: number;
    rejected?: string | null;
    reason?: string | null;
  }>;
}) {
  const { portfolioId, userId, fearIndex, orders } = params;
  if (!userId) return;

  void (async () => {
    try {
      // Previous run's score, so we can tell a fresh crossing from a plateau.
      const { data: prevRows } = await supabaseAdmin
        .from("decisions")
        .select("raw, created_at")
        .eq("portfolio_id", portfolioId)
        .order("created_at", { ascending: false })
        .limit(2);
      let previousScore: number | null = null;
      for (const row of (prevRows ?? []).slice(1)) {
        const raw = (row.raw ?? {}) as { fear_index?: { score?: unknown } };
        const s = raw.fear_index?.score;
        if (typeof s === "number" && Number.isFinite(s)) previousScore = s;
      }

      const verdict = evaluateFearAlert({
        score: fearIndex.score,
        label: fearIndex.label,
        sizeMultiplier: fearIndex.sizeMultiplier,
        blockNewBuys: fearIndex.blockNewBuys,
        reason: fearIndex.reason ?? null,
        orders,
        previousScore,
      });
      if (!verdict.fire) return;

      const now = Date.now();
      const cooldownSince = new Date(now - COOLDOWN_HOURS * 3600_000).toISOString();
      const { data: recent } = await supabaseAdmin
        .from("notifications")
        .select("id, details")
        .eq("user_id", userId)
        .eq("category", "fear_index")
        .eq("portfolio_id", portfolioId)
        .gte("created_at", cooldownSince)
        .limit(5);
      // An escalation into panic always gets through the cool-down.
      const alreadySameLevel = (recent ?? []).some((r) => {
        const d = (r.details ?? {}) as { level?: string };
        return d.level === verdict.level;
      });
      if (alreadySameLevel) return;

      await supabaseAdmin.from("notifications").insert({
        user_id: userId,
        category: "fear_index",
        severity: verdict.severity,
        title: verdict.title,
        body: verdict.body,
        portfolio_id: portfolioId,
        details: {
          level: verdict.level,
          score: fearIndex.score,
          label: fearIndex.label,
          size_multiplier: fearIndex.sizeMultiplier,
          block_new_buys: fearIndex.blockNewBuys,
          previous_score: previousScore,
          blocked_symbols: verdict.blockedSymbols,
          resized_symbols: verdict.resizedSymbols,
          thresholds: FEAR_ALERT_THRESHOLDS,
        },
      });

      try {
        await sendPushToUser(userId, {
          title: verdict.title,
          body: verdict.body,
          url: `/portfolio/${portfolioId}`,
          tag: `fear-index-${portfolioId}`,
          requireInteraction: verdict.level === "panic",
        });
      } catch (e) {
        console.warn("fear-index push failed", e instanceof Error ? e.message : String(e));
      }

      const url = process.env.FEAR_ALERT_WEBHOOK_URL ?? process.env.PRECHECK_ALERT_WEBHOOK_URL;
      if (url) {
        const token =
          process.env.FEAR_ALERT_WEBHOOK_TOKEN ?? process.env.PRECHECK_ALERT_WEBHOOK_TOKEN;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5_000);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers,
            signal: ctrl.signal,
            body: JSON.stringify({
              event: "fear_index.threshold",
              portfolioId,
              userId,
              level: verdict.level,
              score: fearIndex.score,
              previousScore,
              sizeMultiplier: fearIndex.sizeMultiplier,
              blockNewBuys: fearIndex.blockNewBuys,
              blockedSymbols: verdict.blockedSymbols,
              resizedSymbols: verdict.resizedSymbols,
              thresholds: FEAR_ALERT_THRESHOLDS,
              at: new Date(now).toISOString(),
            }),
          });
          if (!res.ok) console.warn("fear-index webhook non-2xx", res.status);
          await res.body?.cancel().catch(() => undefined);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (e) {
      console.warn("fear-index-notify failed", e instanceof Error ? e.message : String(e));
    }
  })();
}
