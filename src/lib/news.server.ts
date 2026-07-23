// Lightweight global news fetcher using GDELT DOC API (free, no key).
// Caches results by date in news_cache.

import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
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
//
// Uses the AI SDK's Output.object structured-output path (same as the
// sentiment scorer). The previous raw-fetch call relied on
// `response_format: json_object`, which Gemini through the gateway ignores
// intermittently, silently returning free-form text that then failed
// JSON.parse and degraded every headline back to untranslated.

const TranslateSchema = z.object({
  results: z.array(
    z.object({
      i: z.number(),
      lang: z.string().nullable().optional(),
      translation: z.string().nullable().optional(),
    }),
  ),
});

// Fast heuristic: skip translation when a headline is plainly ASCII/Latin
// and does not obviously contain non-English words. We keep this permissive
// (any non-ASCII char routes through the LLM) so accented Latin scripts and
// mixed-script headlines still get language-detected.
export function looksNonEnglish(s: string): boolean {
  // Any char outside basic ASCII printable + common punctuation triggers
  // translation. Cheap, safe over-approximation.
  return /[^\x00-\x7F]/.test(s);
}

// -------- Translation caching --------
//
// Translations are deterministic and stable, so we cache them at three
// layers to keep API calls to a minimum on re-renders and refreshes:
//
//   1. Persistent DB cache — the news_cache row itself; once a headline is
//      translated, `headline` holds English and `original_headline` /
//      `original_language` are set. Every read path already prefers cached
//      rows before hitting GDELT, so a translated row is never re-sent.
//   2. In-memory per-worker LRU keyed by the source headline text — repeat
//      appearances (same story, different day or source) skip the LLM
//      entirely. Also used to hydrate freshly-fetched GDELT items from any
//      prior translation of the same headline stored in news_cache.
//   3. In-flight de-duplication on `backfillTranslations(dateISO)` so many
//      concurrent renders sharing a request don't stampede the LLM.

type TranslationCacheEntry = {
  lang: string | null; // null = English (or unknown/no-translate)
  translation: string | null; // null = no translation needed
};

const TRANSLATION_CACHE_MAX = 2000;
const translationCache = new Map<string, TranslationCacheEntry>();

function cacheGet(headline: string): TranslationCacheEntry | undefined {
  const hit = translationCache.get(headline);
  if (!hit) return undefined;
  // LRU touch — reinserting moves it to newest position.
  translationCache.delete(headline);
  translationCache.set(headline, hit);
  return hit;
}

function cacheSet(headline: string, entry: TranslationCacheEntry): void {
  if (translationCache.has(headline)) translationCache.delete(headline);
  translationCache.set(headline, entry);
  if (translationCache.size > TRANSLATION_CACHE_MAX) {
    // Evict oldest.
    const oldest = translationCache.keys().next().value;
    if (oldest !== undefined) translationCache.delete(oldest);
  }
}

// Warm the in-memory cache from already-translated rows so repeated appearances
// of the same source headline (across days/sources) skip the LLM.
async function hydrateFromDbByOriginal(originals: string[]): Promise<void> {
  const missing = originals.filter((h) => !translationCache.has(h));
  if (missing.length === 0) return;
  try {
    const { data } = await supabaseAdmin
      .from("news_cache")
      .select("headline, original_headline, original_language")
      .in("original_headline", missing)
      .not("original_language", "is", null)
      .limit(500);
    for (const r of data ?? []) {
      const orig = (r as { original_headline: string | null }).original_headline;
      const lang = (r as { original_language: string | null }).original_language;
      const translated = (r as { headline: string }).headline;
      if (!orig || !lang || !translated) continue;
      cacheSet(orig, { lang, translation: translated });
    }
  } catch (err) {
    // Non-fatal — the cache just stays cold for these keys.
    console.warn("news: cache hydrate failed", err instanceof Error ? err.message : String(err));
  }
}

async function callTranslateLLM(
  headlines: { i: number; text: string }[],
): Promise<Map<number, TranslationCacheEntry>> {
  const out = new Map<number, TranslationCacheEntry>();
  const key = process.env.LOVABLE_API_KEY;
  if (!key || headlines.length === 0) return out;

  const gateway = createLovableAiGatewayProvider(key);
  const model = gateway("google/gemini-3.6-flash");

  const prompt = `For each numbered headline below, detect its language and, if it is NOT English, translate it into natural English. Use the full English name of the language (e.g. "Spanish", "Mandarin Chinese", "Macedonian"). When the headline is already in English, set lang to "English" and translation to null. Never invent facts — translate only.

Headlines:
${headlines.map((h) => `${h.i}. ${h.text}`).join("\n")}`;

  try {
    const { output } = await generateText({
      model,
      prompt,
      output: Output.object({ schema: TranslateSchema }),
    });
    for (const r of output.results) {
      out.set(r.i, {
        lang: (r.lang ?? "").trim() || null,
        translation: (r.translation ?? "")?.toString().trim() || null,
      });
    }
  } catch (err) {
    if (!NoObjectGeneratedError.isInstance(err)) {
      console.warn("news: translate LLM failed", err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

// Batch-translate with caching. Cached entries never hit the LLM;
// remaining items are batched into a single gateway call.
async function translateWithCache(
  headlines: string[],
): Promise<Map<string, TranslationCacheEntry>> {
  const result = new Map<string, TranslationCacheEntry>();
  if (headlines.length === 0) return result;

  // De-duplicate identical inputs so a batch of repeats sends one call.
  const uniq = Array.from(new Set(headlines));

  // 1. Memory cache.
  const stillMissing: string[] = [];
  for (const h of uniq) {
    const hit = cacheGet(h);
    if (hit) result.set(h, hit);
    else stillMissing.push(h);
  }
  if (stillMissing.length === 0) return result;

  // 2. Try to hydrate from persistent cache (translations of the same
  //    original headline previously stored on another date/source).
  await hydrateFromDbByOriginal(stillMissing);
  const truly: string[] = [];
  for (const h of stillMissing) {
    const hit = cacheGet(h);
    if (hit) result.set(h, hit);
    else truly.push(h);
  }
  if (truly.length === 0) return result;

  // 3. LLM call for what's left, then persist in memory.
  const numbered = truly.map((text, i) => ({ i, text }));
  const byIndex = await callTranslateLLM(numbered);
  for (let i = 0; i < truly.length; i++) {
    const entry = byIndex.get(i);
    if (!entry) continue;
    cacheSet(truly[i], entry);
    result.set(truly[i], entry);
  }
  return result;
}

export async function translateHeadlines(items: NewsItem[]): Promise<NewsItem[]> {
  if (items.length === 0) return items;

  // Only send candidates that plausibly aren't English. Keeps the prompt
  // small, cost low, and avoids spurious "translations" of English text.
  const candidates = items.filter((it) => looksNonEnglish(it.headline));
  if (candidates.length === 0) return items;

  const byOriginal = await translateWithCache(candidates.map((c) => c.headline));
  return items.map((it) => {
    const t = byOriginal.get(it.headline);
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
}

// Repair pass: translate rows already cached with a null original_language
// but a non-ASCII headline. Prior ingests (before translation shipped, or
// during LLM outages) left these rows untranslated. Runs opportunistically —
// bounded batch, best-effort, never throws. De-duplicated per date so
// concurrent renders don't stampede.
const backfillInFlight = new Map<string, Promise<{ scanned: number; translated: number }>>();

export function backfillTranslations(
  dateISO: string,
  max = 30,
): Promise<{ scanned: number; translated: number }> {
  const existing = backfillInFlight.get(dateISO);
  if (existing) return existing;
  const p = (async () => {
    try {
      const { data } = await supabaseAdmin
        .from("news_cache")
        .select("news_date, headline, original_language")
        .eq("news_date", dateISO)
        .is("original_language", null)
        .limit(200);
      const rows = (data ?? [])
        .filter((r) => looksNonEnglish(r.headline as string))
        .slice(0, max);
      if (rows.length === 0) return { scanned: 0, translated: 0 };

      const byOriginal = await translateWithCache(rows.map((r) => r.headline as string));
      let translated = 0;
      for (const r of rows) {
        const originalHeadline = r.headline as string;
        const t = byOriginal.get(originalHeadline);
        if (!t) continue;
        const isEnglish = !t.lang || /^en(glish)?$/i.test(t.lang);
        if (isEnglish || !t.translation) continue;
        const { error } = await supabaseAdmin
          .from("news_cache")
          .update({
            headline: t.translation,
            original_headline: originalHeadline,
            original_language: t.lang,
          } as never)
          .eq("news_date", dateISO)
          .eq("headline", originalHeadline);
        if (!error) translated++;
      }
      if (translated > 0) {
        console.log(`news: backfilled ${translated}/${rows.length} translations for ${dateISO}`);
      }
      return { scanned: rows.length, translated };
    } catch (err) {
      console.warn("news: backfill threw", err instanceof Error ? err.message : String(err));
      return { scanned: 0, translated: 0 };
    } finally {
      backfillInFlight.delete(dateISO);
    }
  })();
  backfillInFlight.set(dateISO, p);
  return p;
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
    .select("news_date, source, headline, url, summary, original_headline, original_language")
    .eq("news_date", dateISO)
    .limit(max);

  const cachedItems: NewsItem[] = (cached ?? []).map((r) => ({
    date: r.news_date as string,
    source: r.source,
    headline: r.headline,
    url: r.url,
    summary: r.summary,
    original_headline: (r as { original_headline?: string | null }).original_headline ?? null,
    original_language: (r as { original_language?: string | null }).original_language ?? null,
  }));

  // Any cached non-English rows still missing a translation get repaired
  // in the background on every read. Bounded and fire-and-forget so it
  // never blocks the reel or the trading engine.
  const untranslatedCount = cachedItems.filter(
    (c) => !c.original_language && looksNonEnglish(c.headline),
  ).length;
  if (untranslatedCount > 0) {
    void backfillTranslations(dateISO);
  }

  // Use existing cache when we're not forcing a refresh and it looks healthy.
  if (!opts?.forceRefresh && cachedItems.length >= 5) return cachedItems;

  const gdelt = await fetchGdeltForDate(dateISO, max);
  if (gdelt === null) {
    // Provider unavailable — preserve whatever cache we already have instead
    // of nuking it. Better a stale reel than an empty one.
    console.warn(`news: keeping ${cachedItems.length} cached rows for ${dateISO} (provider unavailable)`);
    return cachedItems;
  }
  if (gdelt.length === 0) return cachedItems;


  // Translate before writing so the cache holds English + original metadata.
  const fresh = await translateHeadlines(gdelt);

  // We have a real fresh set. Only NOW do we replace today's rows on
  // forceRefresh; otherwise merge (skip duplicates by headline).
  if (opts?.forceRefresh) {
    await supabaseAdmin.from("news_cache").delete().eq("news_date", dateISO);
  }
  const existingHeads = new Set(
    opts?.forceRefresh
      ? []
      : cachedItems.flatMap((c) => [c.headline, c.original_headline ?? ""].filter(Boolean)),
  );
  const rows = fresh
    .filter((n) => !existingHeads.has(n.headline) && !(n.original_headline && existingHeads.has(n.original_headline)))
    .map((n) => ({
      news_date: n.date,
      source: n.source,
      headline: n.headline,
      url: n.url,
      summary: n.summary,
      original_headline: n.original_headline,
      original_language: n.original_language,
    }));
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("news_cache").insert(rows);
    if (error) console.error("news: cache insert failed", error);
  }
  return fresh;
}


