// Scheduled market scan. pg_cron POSTs here on a fixed cadence; the handler
// refreshes the post-reclaim setup scan and stores the result so the UI can
// read cached matches instantly without triggering a scan itself.
//
// Security: gated exactly like every other /api/public/hooks/* endpoint —
// private CRON_SECRET, HMAC signature over timestamp+path, and a token-bucket
// rate limit. The scan burns third-party price-API quota, so it must never be
// triggerable with the publishable key that ships in the browser bundle.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/setup-scan-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        // Hourly cadence with headroom for a manual re-run; well under the
        // upstream provider's quota even if every token is spent.
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:setup-scan-cron",
          capacity: 12,
          refillPerSec: 12 / 3600,
          requireSignature: true,
        });
        if (!verified.ok) return verified.response;

        const { getOrRefreshScan } = await import("@/lib/setup-scan-schedule.server");
        try {
          const { run, refreshed, note } = await getOrRefreshScan({
            source: "cron",
            force: true,
          });
          return Response.json({
            success: true,
            refreshed,
            note,
            scanned: run?.scanned ?? 0,
            matches: run?.matches.length ?? 0,
            rateLimited: run?.rateLimited ?? false,
            ranAt: run?.ranAt ?? null,
          });
        } catch (err) {
          console.error("setup-scan-cron: scan failed", err);
          return new Response(
            JSON.stringify({
              success: false,
              error: err instanceof Error ? err.message : "Scan failed",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
