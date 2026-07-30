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

        let max = 60;
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

        // Do the work inline. The previous version returned 202 immediately
        // and relied on waitUntil, but the Worker tears the isolate down as
        // soon as the response is sent when no execution context is bound —
        // so the cache was never written and the reel went stale.
        const today = new Date().toISOString().slice(0, 10);
        try {
          const { getNewsForDate } = await import("@/lib/news.server");
          const { ensureSentimentScored } = await import("@/lib/sentiment.server");
          const items = await getNewsForDate(today, max, { forceRefresh });
          const scored = items.length > 0 ? await ensureSentimentScored(today, items) : [];
          const scoredCount = scored.filter((item) => item.sentiment != null).length;
          // Portfolio-relevance pass: every fresh headline is ranked against
          // the user's holdings, universe and risk level before it can reach
          // the reel, so priority ordering is available on first read.
          let relevanceScored = 0;
          try {
            const { ensureRelevanceScored } = await import("@/lib/news-relevance.server");
            relevanceScored = (await ensureRelevanceScored(today)).scored;
          } catch (err) {
            console.warn("news-refresh: relevance pass failed", err instanceof Error ? err.message : String(err));
          }
          console.log(
            `news-refresh: completed for ${today} (${items.length} headlines, ${scoredCount} scored, ${relevanceScored} ranked)`,
          );
          return new Response(
            JSON.stringify({
              success: true,
              date: today,
              headlines: items.length,
              scored: scoredCount,
              relevance_scored: relevanceScored,
              at: new Date().toISOString(),
              max,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        } catch (error) {
          console.error("news-refresh: refresh failed", error);
          return new Response(
            JSON.stringify({ success: false, date: today, error: String(error) }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

      },
    },
  },
});