// Hourly Aegis-vs-Saxo equity reconciliation.
//
// Runs after the per-run valuation refresh: reads the app's latest stored
// equity snapshot and Saxo's authoritative account total, classifies the gap
// and records it in `live_reconciliation`. Anything at `alert` level also
// raises an in-app notification (deduplicated per portfolio per day) so a
// silent divergence can't sit unnoticed between manual checks.
//
// Never throws: reconciliation is oversight, not part of the trading path.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolvePortfolioBrokerLink } from "@/lib/brokers/portfolio-broker-link.server";
import { asJson } from "@/lib/_server/db-json";
import { classifyEquityDrift, type EquityDrift } from "@/lib/live-equity-reconcile";

export type LiveEquityReconcileResult =
  | { checked: false; reason: string }
  | { checked: true; drift: EquityDrift; currency: string };

export async function reconcileLiveEquityAgainstBroker(
  portfolioId: string,
  userId: string,
): Promise<LiveEquityReconcileResult> {
  try {
    const { data: p } = await supabaseAdmin
      .from("portfolios")
      .select("id, name, user_id, mode, current_cash, broker, broker_account_id")
      .eq("id", portfolioId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!p) return { checked: false, reason: "portfolio not found" };
    if (p.mode !== "live_sim" && p.mode !== "live_prod") {
      return { checked: false, reason: "not a live portfolio" };
    }
    const link = resolvePortfolioBrokerLink(p);
    if (!link.linked) return { checked: false, reason: link.reason };

    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const adapter = await buildSaxoAdapter({
      userId,
      portfolioId,
      envOverride: p.mode === "live_prod" ? "live" : "sim",
      accountKey: link.accountKey,
    });
    const bal = await adapter.getBalance();

    const { data: snap } = await supabaseAdmin
      .from("equity_snapshots")
      .select("snapshot_date, total_value, cash")
      .eq("portfolio_id", portfolioId)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const drift = classifyEquityDrift({
      appTotal: snap ? Number(snap.total_value) : null,
      brokerTotal: Number(bal.totalValue),
      currency: bal.currency,
    });

    await supabaseAdmin.from("live_reconciliation").insert({
      portfolio_id: portfolioId,
      user_id: userId,
      broker_cash: Number(bal.cash),
      local_cash: Number(p.current_cash ?? 0),
      broker_positions: asJson({
        total_value: Number(bal.totalValue),
        currency: bal.currency,
      }),
      local_positions: asJson({
        total_value: drift.appTotal,
        snapshot_date: snap?.snapshot_date ?? null,
        severity: drift.severity,
        diff: drift.diff,
        diff_pct: drift.diffPct,
        check: "equity_vs_broker",
      }),
      drift_flag: drift.severity === "warn" || drift.severity === "alert",
      drift_notes: `equity_${drift.severity}: ${drift.note}`,
    });

    if (drift.severity === "alert") {
      await notifyEquityDrift({
        userId,
        portfolioId,
        portfolioName: p.name ?? "Live portfolio",
        drift,
      });
    }

    return { checked: true, drift, currency: bal.currency };
  } catch (e) {
    return { checked: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function notifyEquityDrift(input: {
  userId: string;
  portfolioId: string;
  portfolioName: string;
  drift: EquityDrift;
}): Promise<void> {
  try {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const existing = await supabaseAdmin
      .from("notifications")
      .select("id")
      .eq("user_id", input.userId)
      .eq("category", "equity_drift")
      .eq("portfolio_id", input.portfolioId)
      .gte("created_at", dayStart.toISOString())
      .limit(1)
      .maybeSingle();
    if (existing.data) return;

    await supabaseAdmin.from("notifications").insert({
      user_id: input.userId,
      portfolio_id: input.portfolioId,
      category: "equity_drift",
      severity: "warning",
      title: `${input.portfolioName}: equity differs from Saxo`,
      body: input.drift.note,
      details: {
        app_total: input.drift.appTotal,
        broker_total: input.drift.brokerTotal,
        diff: input.drift.diff,
        diff_pct: input.drift.diffPct,
        url: `/portfolio/${input.portfolioId}`,
      },
    });
  } catch (e) {
    console.error("notifyEquityDrift failed", e);
  }
}
