// Dedicated background refresh for global-news cache + sentiment scoring.
// Kept separate from the trading tick so slow upstream news providers cannot
// block broker access, order reconciliation, or the hourly market run.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/news-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:news-refresh",
          capacity: 12,
          refillPerSec: 12 / 3600,
        });
        if (!verified.ok) return verified.response;

        let max = 30;
        let forceRefresh = true;
        try {
          const text = await request.clone().text();
          if (text) {
            const body = JSON.parse(text) as { max?: number; forceRefresh?: boolean } | null;
            if (body?.max && Number.isFinite(body.max)) {
              max = Math.min(Math.max(10, Math.floor(body.max)), 80);
            }
            if (body?.forceRefresh === false) forceRefresh = false;
          }
        } catch {
          // Body is optional; defaults are intentionally safe.
        }

        const task = (async () => {
          const today = new Date().toISOString().slice(0, 10);
          const { getNewsForDate } = await import("@/lib/news.server");
          const { ensureSentimentScored } = await import("@/lib/sentiment.server");
          const items = await getNewsForDate(today, max, { forceRefresh });
          const scored = items.length > 0 ? await ensureSentimentScored(today, items) : [];
          const scoredCount = scored.filter((item) => item.sentiment != null).length;
          console.log(
            `news-refresh: completed for ${today} (${items.length} headlines, ${scoredCount} scored)`,
          );
        })().catch((error) => {
          console.error("news-refresh: background refresh failed", error);
        });

        const ctx = (globalThis as unknown as { __cfCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).__cfCtx;
        try {
          ctx?.waitUntil?.(task);
        } catch {
          // In local/dev runtimes the promise continues on the event loop.
        }

        return new Response(
          JSON.stringify({ success: true, started: true, at: new Date().toISOString(), max }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});