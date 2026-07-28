// Cron-triggered credit-budget early warning. Runs once daily.
// Evaluates the in-app burn-rate estimator against the configured monthly
// credit budget and pushes a browser notification (deduped per alert kind
// per UK day) when MTD or projected month-end spend crosses thresholds.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/credit-budget-check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:credit-budget-check",
          capacity: 10,
          refillPerSec: 10 / 86400,
        });
        if (!verified.ok) return verified.response;

        const { evaluateCreditBudget } = await import("@/lib/credit-budget.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const verdict = await evaluateCreditBudget();

        if (!verdict.enabled || verdict.alerts.length === 0) {
          return Response.json({ ok: true, verdict, alerted: false, reason: "no threshold crossed" });
        }

        const { sendPushToUser } = await import("@/lib/push.server");
        const { data: subs } = await supabaseAdmin.from("push_subscriptions").select("user_id");
        const userIds = Array.from(new Set((subs ?? []).map((r) => r.user_id)));

        const results: Array<{ kind: string; alerted: boolean; sent?: number; failed?: number; reason?: string }> = [];

        for (const a of verdict.alerts) {
          // Dedupe: (kind, alert_date). If insert fails on unique violation, skip.
          const ins = await supabaseAdmin
            .from("credit_budget_alerts")
            .insert({
              kind: a.kind,
              alert_date: verdict.alertDate,
              mtd_credits: verdict.mtdCredits,
              projected_month_credits: verdict.projectedMonthCredits,
              budget_credits: verdict.budgetCredits,
              detail: a.remedy,
            })
            .select("id");
          if (ins.error) {
            const dup = ins.error.code === "23505" || /duplicate/i.test(ins.error.message);
            results.push({ kind: a.kind, alerted: false, reason: dup ? "deduped" : ins.error.message });
            continue;
          }

          const title = a.kind === "mtd_over_threshold"
            ? "⚠️ Credit budget: month-to-date threshold"
            : "⚠️ Credit budget: projected overspend";
          let sent = 0, failed = 0;
          for (const uid of userIds) {
            try {
              const r = await sendPushToUser(uid, {
                title,
                body: a.remedy,
                tag: `credit-budget:${a.kind}:${verdict.alertDate}`,
                requireInteraction: true,
                url: "/admin",
              });
              sent += r.sent; failed += r.failed;
            } catch (e) {
              failed++;
              console.warn("credit-budget push failed", e);
            }
          }
          results.push({ kind: a.kind, alerted: true, sent, failed });
        }

        return Response.json({ ok: true, verdict, results });
      },
    },
  },
});
