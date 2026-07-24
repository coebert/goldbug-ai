// Background refresh for the headline translation cache. Runs on a cron
// (hourly by default) so entries whose 30-day TTL is about to expire are
// re-translated proactively — page reads never have to wait for stale rows
// to be repaired inline.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/translation-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:translation-refresh",
          capacity: 30,
          refillPerSec: 30/3600,
        });
        if (!verified.ok) return verified.response;
        let max = 50;
        let soonMs = 24 * 60 * 60 * 1000;
        try {
          const body = (await request.json()) as { max?: number; soonHours?: number } | null;
          if (body?.max && Number.isFinite(body.max)) {
            max = Math.min(Math.max(1, Math.floor(body.max)), 200);
          }
          if (body?.soonHours && Number.isFinite(body.soonHours)) {
            soonMs = Math.min(Math.max(0, body.soonHours), 24 * 30) * 60 * 60 * 1000;
          }
        } catch {
          // no body — use defaults
        }

        const { refreshStaleTranslations } = await import("@/lib/news.server");
        const result = await refreshStaleTranslations(max, soonMs);
        return new Response(
          JSON.stringify({ ok: true, at: new Date().toISOString(), ...result }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
