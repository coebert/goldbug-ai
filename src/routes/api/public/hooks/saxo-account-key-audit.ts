// Cron-triggered revalidation of Saxo account keys.
//
// Asks each broker environment whether the account key bound to each portfolio
// (plus the process-wide default) still exists and is active, and appends the
// outcome to `broker_account_key_audits`. A status change from the previous
// run raises a push alert, so a key that silently stops working is noticed
// before the next trading tick fails on it.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/saxo-account-key-audit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:saxo-account-key-audit",
          capacity: 12,
          refillPerSec: 12 / 86400,
        });
        if (!verified.ok) return verified.response;

        const { revalidateBrokerAccountKeys, isProblemStatus } = await import(
          "@/lib/broker-account-key-audit.server"
        );
        const rows = await revalidateBrokerAccountKeys();
        const changed = rows.filter((r) => r.changed);
        const problems = rows.filter((r) => isProblemStatus(r.status));

        const alerts = changed.filter((r) => isProblemStatus(r.status));
        if (alerts.length > 0) {
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { sendPushToUser } = await import("@/lib/push.server");
            const { data: subs } = await supabaseAdmin.from("push_subscriptions").select("user_id");
            const userIds = Array.from(new Set((subs ?? []).map((r) => r.user_id)));
            const worst = alerts[0]!;
            for (const uid of userIds) {
              await sendPushToUser(uid, {
                title: "⚠️ Broker account key changed status",
                body: `${worst.portfolioName ?? "Portfolio"} (${worst.env}): ${worst.previousStatus} → ${worst.status}.`,
                tag: `account-key-audit:${worst.portfolioId ?? "default"}:${worst.env}:${worst.status}`,
                url: "/",
              });
            }
          } catch (e) {
            console.warn("saxo-account-key-audit push failed", e);
          }
        }

        return Response.json({
          ok: true,
          checked: rows.length,
          changed: changed.length,
          problems: problems.length,
          rows,
        });
      },
    },
  },
});
