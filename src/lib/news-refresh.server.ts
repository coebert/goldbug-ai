// On-demand refresh of the global-events news cache.
//
// The cron hook (`/api/public/hooks/news-refresh`) keeps the cache warm, but
// it only runs against the published deployment. When it is late, blocked, or
// the user simply wants fresh headlines now, the reel's "Refresh now" button
// calls this helper so the cache is rebuilt inline before the reel re-reads
// it. Work happens synchronously — Workers tear the isolate down as soon as
// the response is sent, so background promises never finish in production.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Minimum gap between two on-demand refreshes, in milliseconds. */
const THROTTLE_MS = 90_000;

export type NewsRefreshResult = {
  date: string;
  headlines: number;
  scored: number;
  /** Headlines ranked for portfolio relevance during this refresh. */
  relevance_scored?: number;
  skipped: boolean;
  reason?: string;
};

async function latestFetchedAt(dateISO: string): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from("news_cache")
    .select("fetched_at")
    .eq("news_date", dateISO)
    .order("fetched_at", { ascending: false })
    .limit(1);
  const raw = data?.[0]?.fetched_at as string | undefined;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Fetch + sentiment-score today's headlines into `news_cache`.
 * Throttled so repeated button presses cannot hammer upstream providers.
 */
export async function refreshGlobalNewsNow(max = 60): Promise<NewsRefreshResult> {
  const today = new Date().toISOString().slice(0, 10);
  const last = await latestFetchedAt(today);
  if (last != null && Date.now() - last < THROTTLE_MS) {
    return {
      date: today,
      headlines: 0,
      scored: 0,
      skipped: true,
      reason: "Refreshed moments ago — showing the latest cached headlines.",
    };
  }

  const { getNewsForDate } = await import("./news.server");
  const { ensureSentimentScored } = await import("./sentiment.server");
  const items = await getNewsForDate(today, max, { forceRefresh: true });
  const scored = items.length > 0 ? await ensureSentimentScored(today, items) : [];

  // Rank fresh headlines against the user's book before the reel reads them.
  let relevanceScored = 0;
  if (items.length > 0) {
    try {
      const { ensureRelevanceScored } = await import("./news-relevance.server");
      relevanceScored = (await ensureRelevanceScored(today)).scored;
    } catch (err) {
      console.warn("news-refresh: relevance pass failed", err instanceof Error ? err.message : String(err));
    }
  }

  return {
    date: today,
    headlines: items.length,
    scored: scored.filter((s) => s.sentiment != null).length,
    relevance_scored: relevanceScored,
    skipped: false,
  };
}
