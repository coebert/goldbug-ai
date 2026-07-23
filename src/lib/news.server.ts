// Lightweight global news fetcher using GDELT DOC API (free, no key).
// Caches results by date in news_cache.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type NewsItem = {
  date: string;
  source: string | null;
  headline: string;
  url: string | null;
  summary: string | null;
};

type GdeltArticle = {
  title?: string;
  url?: string;
  domain?: string;
  seendate?: string;
};

async function fetchGdelt(dateISO: string, max = 20): Promise<NewsItem[]> {
  // GDELT expects YYYYMMDDHHMMSS ranges
  const day = dateISO.replace(/-/g, "");
  const start = `${day}000000`;
  const end = `${day}235959`;
  const query = encodeURIComponent(
    "(economy OR markets OR inflation OR \"interest rates\" OR earnings OR geopolitics OR OPEC OR \"central bank\")",
  );
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&format=json&maxrecords=${max}&sort=hybridrel&startdatetime=${start}&enddatetime=${end}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LovableTrader/1.0)" },
    });
    if (!res.ok) return [];
    const text = await res.text();
    if (!text || text.trim().startsWith("<")) return [];
    const json = JSON.parse(text) as { articles?: GdeltArticle[] };
    return (json.articles ?? [])
      .filter((a) => a.title)
      .slice(0, max)
      .map((a) => ({
        date: dateISO,
        source: a.domain ?? null,
        headline: a.title!,
        url: a.url ?? null,
        summary: null,
      }));
  } catch (err) {
    console.error("news: gdelt fetch failed", err);
    return [];
  }
}

export async function getNewsForDate(
  dateISO: string,
  max = 15,
  opts?: { forceRefresh?: boolean },
): Promise<NewsItem[]> {
  if (opts?.forceRefresh) {
    await supabaseAdmin.from("news_cache").delete().eq("news_date", dateISO);
  }

  const { data: cached } = await supabaseAdmin
    .from("news_cache")
    .select("news_date, source, headline, url, summary")
    .eq("news_date", dateISO)
    .limit(max);

  if (cached && cached.length >= 5) {
    return cached.map((r) => ({
      date: r.news_date as string,
      source: r.source,
      headline: r.headline,
      url: r.url,
      summary: r.summary,
    }));
  }

  const fresh = await fetchGdelt(dateISO, max);
  if (fresh.length > 0) {
    await supabaseAdmin.from("news_cache").insert(
      fresh.map((n) => ({
        news_date: n.date,
        source: n.source,
        headline: n.headline,
        url: n.url,
        summary: n.summary,
      })),
    );
  }
  return fresh;
}
