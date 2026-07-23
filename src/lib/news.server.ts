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
        original_headline: null,
        original_language: null,
      }));
  } catch (err) {
    console.error("news: gdelt JSON parse failed", err);
    return null;
  }
}

// Batch-translate non-English headlines to English via the Lovable AI Gateway.
// The model both detects the language and returns the English translation in a
// single call. English headlines are left untouched (original_language stays
// null). Failures degrade to the original headlines rather than blocking the
// ingest pipeline — a stale-but-untranslated reel beats an empty one.
async function translateHeadlines(items: NewsItem[]): Promise<NewsItem[]> {
  if (items.length === 0) return items;
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return items;

  // Ask the model to classify + translate every headline in one JSON payload.
  // Keeping the schema shallow avoids Gemini's "too many states" rejections.
  const numbered = items.map((it, i) => `${i}. ${it.headline}`).join("\n");
  const system =
    'You are a translator. For each numbered headline, detect its language and, if it is not English, translate it to natural English. Reply with STRICT JSON of the form {"results":[{"i":0,"lang":"English","translation":null}, ...]}. Use the full English name of the language (e.g. "Spanish", "Mandarin Chinese"). When the headline is already in English, set lang to "English" and translation to null. Never invent facts — translate only.';
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
        "X-Lovable-AIG-SDK": "fetch",
      },
      body: JSON.stringify({
        model: "google/gemini-3.6-flash",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: numbered },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`news: translate request failed ${res.status}`);
      return items;
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as {
      results?: Array<{ i?: number; lang?: string | null; translation?: string | null }>;
    };
    const byIndex = new Map<number, { lang: string | null; translation: string | null }>();
    for (const r of parsed.results ?? []) {
      if (typeof r.i === "number") {
        byIndex.set(r.i, {
          lang: (r.lang ?? "").trim() || null,
          translation: (r.translation ?? "")?.toString().trim() || null,
        });
      }
    }
    return items.map((it, i) => {
      const t = byIndex.get(i);
      if (!t) return it;
      const isEnglish = !t.lang || /^en(glish)?$/i.test(t.lang);
      if (isEnglish || !t.translation) return it;
      return {
        ...it,
        headline: t.translation,
        original_headline: it.headline,
        original_language: t.lang,
      };
    });
  } catch (err) {
    console.warn("news: translate threw", err instanceof Error ? err.message : String(err));
    return items;
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


