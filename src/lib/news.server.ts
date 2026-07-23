// Lightweight global news fetcher using GDELT DOC API (free, no key).
// Caches results by date in news_cache.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type NewsItem = {
  date: string;
  source: string | null;
  headline: string;
  url: string | null;
  summary: string | null;
  original_headline: string | null;
  original_language: string | null;
};

type GdeltArticle = {
  title?: string;
  url?: string;
  domain?: string;
  seendate?: string;
};

async function parseGdeltResponse(res: Response, dateISO: string): Promise<NewsItem[] | null> {
  // Returns null when the response wasn't usable JSON (rate limit, HTML error,
  // etc.) so callers can distinguish "provider unavailable" from "no articles".
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) return [];
  // GDELT rate-limit response is plain text starting with "Please limit requests…".
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const snippet = trimmed.slice(0, 160).replace(/\s+/g, " ");
    console.warn(`news: gdelt returned non-JSON (likely rate-limited): ${snippet}`);
    return null;
  }
  try {
    const json = JSON.parse(trimmed) as { articles?: GdeltArticle[] };
    return (json.articles ?? [])
      .filter((a) => a.title)
      .map((a) => ({
        date: dateISO,
        source: a.domain ?? null,
        headline: a.title!,
        url: a.url ?? null,
        summary: null,
      }));
  } catch (err) {
    console.error("news: gdelt JSON parse failed", err);
    return null;
  }
}

async function fetchGdeltForDate(dateISO: string, max = 20): Promise<NewsItem[] | null> {
  // GDELT expects YYYYMMDDHHMMSS ranges. In some regions the dated-range query
  // is 429'd more aggressively than the `timespan=24h` variant, so we try the
  // dated query first and fall back to timespan for "today" only.
  const day = dateISO.replace(/-/g, "");
  const start = `${day}000000`;
  const end = `${day}235959`;
  const query = encodeURIComponent(
    "(economy OR markets OR inflation OR \"interest rates\" OR earnings OR geopolitics OR OPEC OR \"central bank\")",
  );
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; LovableTrader/1.0)" };
  const dated = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&format=json&maxrecords=${max}&sort=hybridrel&startdatetime=${start}&enddatetime=${end}`;
  try {
    const res = await fetch(dated, { headers });
    if (res.ok) {
      const parsed = await parseGdeltResponse(res, dateISO);
      if (parsed && parsed.length > 0) return parsed.slice(0, max);
      // parsed === null → rate-limited/non-JSON; parsed === [] → no matches.
      // Fall through to fallback for today only.
    } else {
      console.warn(`news: gdelt dated request failed ${res.status}`);
    }
  } catch (err) {
    console.error("news: gdelt dated fetch threw", err);
  }

  // Fallback (only for today) using the more lenient `timespan=24h` endpoint.
  const today = new Date().toISOString().slice(0, 10);
  if (dateISO !== today) return null;
  await new Promise((r) => setTimeout(r, 1200)); // brief pause before retry
  const fallback = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&format=json&maxrecords=${max}&sort=hybridrel&timespan=24h`;
  try {
    const res = await fetch(fallback, { headers });
    if (!res.ok) {
      console.warn(`news: gdelt fallback failed ${res.status}`);
      return null;
    }
    const parsed = await parseGdeltResponse(res, dateISO);
    return parsed ? parsed.slice(0, max) : null;
  } catch (err) {
    console.error("news: gdelt fallback threw", err);
    return null;
  }
}

export async function getNewsForDate(
  dateISO: string,
  max = 15,
  opts?: { forceRefresh?: boolean },
): Promise<NewsItem[]> {
  const { data: cached } = await supabaseAdmin
    .from("news_cache")
    .select("news_date, source, headline, url, summary")
    .eq("news_date", dateISO)
    .limit(max);

  const cachedItems = (cached ?? []).map((r) => ({
    date: r.news_date as string,
    source: r.source,
    headline: r.headline,
    url: r.url,
    summary: r.summary,
  }));

  // Use existing cache when we're not forcing a refresh and it looks healthy.
  if (!opts?.forceRefresh && cachedItems.length >= 5) return cachedItems;

  const fresh = await fetchGdeltForDate(dateISO, max);
  if (fresh === null) {
    // Provider unavailable — preserve whatever cache we already have instead
    // of nuking it. Better a stale reel than an empty one.
    console.warn(`news: keeping ${cachedItems.length} cached rows for ${dateISO} (provider unavailable)`);
    return cachedItems;
  }
  if (fresh.length === 0) return cachedItems;

  // We have a real fresh set. Only NOW do we replace today's rows on
  // forceRefresh; otherwise merge (skip duplicates by headline).
  if (opts?.forceRefresh) {
    await supabaseAdmin.from("news_cache").delete().eq("news_date", dateISO);
  }
  const existingHeads = new Set(
    opts?.forceRefresh ? [] : cachedItems.map((c) => c.headline),
  );
  const rows = fresh
    .filter((n) => !existingHeads.has(n.headline))
    .map((n) => ({
      news_date: n.date,
      source: n.source,
      headline: n.headline,
      url: n.url,
      summary: n.summary,
    }));
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("news_cache").insert(rows);
    if (error) console.error("news: cache insert failed", error);
  }
  return fresh;
}


