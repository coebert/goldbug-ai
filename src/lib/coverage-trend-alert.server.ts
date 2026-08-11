// Hourly notifier for a rotting broker-charge coverage trend.
//
// `cost-sync-alert.server` grades a single ingest pass; this grades the shape
// of coverage over the last three 7-day windows, so a slow slide raises an
// alert even when every individual pass looked survivable.

import { evaluateCoverageTrendAlert, formatCoverageWindow } from "./coverage-trend-alert";

export const COVERAGE_TREND_ALERT_CATEGORY = "broker_cost_coverage_trend";
const COOLDOWN_HOURS = 24;

export function maybeNotifyCoverageTrend(params: {
  portfolioId: string;
  userId: string;
  portfolioName?: string | null;
}) {
  const { portfolioId, userId, portfolioName } = params;
  if (!portfolioId || !userId) return;

  void (async () => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { loadCoverageTrend } = await import("./fee-coverage-trend.server");

      const trend = await loadCoverageTrend({ db: supabaseAdmin, days: 30, windowDays: 7 });
      const series = trend.portfolios.find((s) => s.portfolioId === portfolioId);
      if (!series) return;

      const alert = evaluateCoverageTrendAlert(series, { windowDays: 7 });
      if (!alert.shouldAlert) return;

      const cooldownSince = new Date(Date.now() - COOLDOWN_HOURS * 3600_000).toISOString();
      const { data: recent } = await supabaseAdmin
        .from("notifications")
        .select("id")
        .eq("user_id", userId)
        .eq("category", COVERAGE_TREND_ALERT_CATEGORY)
        .eq("portfolio_id", portfolioId)
        .gte("created_at", cooldownSince)
        .limit(1);
      if (recent && recent.length > 0) return;

      const label = portfolioName ? ` (${portfolioName})` : "";
      const [recentWin, priorWin] = alert.windows;
      // Spell out the two windows in the body so the bell entry is
      // self-explanatory without opening the chart.
      const windowLine =
        ` Windows compared: ${formatCoverageWindow(recentWin)} ${recentWin.coveragePct ?? "—"}% vs ` +
        `${formatCoverageWindow(priorWin)} ${priorWin.coveragePct ?? "—"}%.`;
      await supabaseAdmin.from("notifications").insert({
        user_id: userId,
        category: COVERAGE_TREND_ALERT_CATEGORY,
        severity: alert.severity,
        title: `${alert.title}${label}`,
        body: `${alert.body}${windowLine}`,
        portfolio_id: portfolioId,
        details: {
          reason: alert.reason,
          recent_pct: alert.recentPct,
          prior_pct: alert.priorPct,
          earlier_pct: alert.earlierPct,
          window_days: 7,
          windows: alert.windows.map((w) => ({
            index: w.index,
            start_date: w.startDate,
            end_date: w.endDate,
            coverage_pct: w.coveragePct,
            graded_days: w.gradedDays,
          })),
        },
      });
    } catch (e) {
      console.warn("coverage-trend-alert failed", e instanceof Error ? e.message : String(e));
    }
  })();
}
