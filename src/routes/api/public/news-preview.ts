// Read-only, unauthenticated snapshot of recent translated headlines. Used
// by end-to-end tests and external crawlers to verify translation quality
// without exposing per-user data. Only whitelisted fields are returned; no
// user IDs, portfolio data, or AI notes are included.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/news-preview")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { checkRateLimit, tooManyRequests } = await import(
          "@/lib/rate-limit.server"
        );
        const rl = await checkRateLimit(request, {
          bucket: "public:news-preview",
          capacity: 60,
          refillPerSec: 60 / 3600,
        });
        if (!rl.allowed) return tooManyRequests(rl);

        const url = new URL(request.url);
        const limitParam = Number(url.searchParams.get("limit") ?? "40");
        const limit = Math.min(
          Math.max(1, Number.isFinite(limitParam) ? Math.floor(limitParam) : 40),
          100,
        );

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const { data, error } = await supabaseAdmin
          .from("news_cache")
          .select(
            "date, source, headline, url, original_headline, original_language, translation_confidence",
          )
          .order("date", { ascending: false })
          .limit(limit);

        if (error) {
          return new Response(
            JSON.stringify({ error: "fetch_failed" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        const items = (data ?? []).map((row) => ({
          date: row.date,
          source: row.source,
          headline: row.headline,
          url: row.url,
          original_headline: row.original_headline,
          original_language: row.original_language,
          translation_confidence: row.translation_confidence,
          translated:
            row.original_headline != null &&
            row.original_headline !== row.headline,
        }));

        const translated = items.filter((i) => i.translated).length;

        return new Response(
          JSON.stringify({
            ok: true,
            at: new Date().toISOString(),
            total: items.length,
            translated,
            items,
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=60",
            },
          },
        );
      },
    },
  },
});
