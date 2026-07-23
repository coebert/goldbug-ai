// Background refresh for the headline translation cache. Runs on a cron
// (hourly by default) so entries whose 30-day TTL is about to expire are
// re-translated proactively — page reads never have to wait for stale rows
// to be repaired inline.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/translation-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { checkRateLimit, tooManyRequests } = await import("@/lib/rate-limit.server");
        const rl = await checkRateLimit(request, {
          bucket: "hooks:translation-refresh",
          capacity: 30,
          refillPerSec: 30 / 3600,
        });
        if (!rl.allowed) return tooManyRequests(rl);

        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        const expected = process.env.CRON_SECRET;
        if (!expected || provided !== expected) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

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
