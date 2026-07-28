// Per-symbol chronic-miss alerting. Complements the two-cycle empty-orders
// alert with a broader "this symbol keeps failing" signal computed over a
// 72h window of ai_decision_audit rows. Cooldown per (portfolio, symbol)
// avoids spamming the notifications feed.
//
// Threshold: at least MIN_INTENDED intended orders in the window AND
// executed_rate <= MAX_EXECUTED_RATE (fraction that ever reached the broker).
// Fire-and-forget: never fails the calling tick.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { computeIntendedVsExecuted } from "@/lib/intended-vs-executed.functions";

const WINDOW_HOURS = 72;
const MIN_INTENDED = 5;
const MAX_EXECUTED_RATE = 0.2;
const COOLDOWN_HOURS = 24;

export function maybeAlertIntendedVsExecuted(params: {
  portfolioId: string;
  userId: string;
  portfolioName?: string | null;
}) {
  const { portfolioId, userId } = params;
  if (!portfolioId || !userId) return;

  void (async () => {
    try {
      const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString();
      const { data: rows, error } = await supabaseAdmin
        .from("ai_decision_audit")
        .select("symbol, action, outcome, outcome_detail")
        .eq("portfolio_id", portfolioId)
        .gte("decided_at", since)
        .limit(10_000);
      if (error) throw error;

      const metrics = computeIntendedVsExecuted(
        (rows ?? []) as { symbol: string; action: string; outcome: string; outcome_detail: string | null }[],
        portfolioId,
        WINDOW_HOURS,
        since,
      );

      const chronic = metrics.symbols.filter(
        (s) => s.intended >= MIN_INTENDED && s.executed_rate <= MAX_EXECUTED_RATE,
      );
      if (chronic.length === 0) return;

      const cooldownSince = new Date(
        Date.now() - COOLDOWN_HOURS * 3600_000,
      ).toISOString();
      const { data: recent } = await supabaseAdmin
        .from("notifications")
        .select("id, details")
        .eq("user_id", userId)
        .eq("category", "intended_vs_executed")
        .eq("portfolio_id", portfolioId)
        .gte("created_at", cooldownSince);
      const alreadyAlerted = new Set<string>();
      for (const n of recent ?? []) {
        const sym = (n.details as { symbol?: unknown } | null)?.symbol;
        if (typeof sym === "string") alreadyAlerted.add(sym.toUpperCase());
      }

      const fresh = chronic.filter((s) => !alreadyAlerted.has(s.symbol));
      if (fresh.length === 0) return;

      const inserts = fresh.slice(0, 10).map((s) => ({
        user_id: userId,
        category: "intended_vs_executed",
        severity: "warning",
        title: `${s.symbol}: only ${Math.round(s.executed_rate * 100)}% of intended orders reached the broker`,
        body:
          `Over the last ${WINDOW_HOURS}h the AI intended ${s.intended} order(s) in ` +
          `${s.symbol}; ${s.executed} reached the broker and ${s.filled} filled. ` +
          (s.top_miss_reason ? `Top miss reason: ${s.top_miss_reason}.` : ""),
        portfolio_id: portfolioId,
        details: {
          symbol: s.symbol,
          intended: s.intended,
          executed: s.executed,
          filled: s.filled,
          missed: s.missed,
          executed_rate: s.executed_rate,
          fill_rate: s.fill_rate,
          top_miss_reason: s.top_miss_reason,
          window_hours: WINDOW_HOURS,
          min_intended: MIN_INTENDED,
          max_executed_rate: MAX_EXECUTED_RATE,
          portfolio_name: params.portfolioName ?? null,
        },
      }));

      const { error: insErr } = await supabaseAdmin.from("notifications").insert(inserts);
      if (insErr) throw insErr;
    } catch (e) {
      console.warn(
        "intended-vs-executed alert failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  })();
}
