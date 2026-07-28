// Lightweight global news fetcher using GDELT DOC API (free, no key).
// Caches results by date in news_cache.

import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";


export type NewsItem = {
  date: string;
  source: string | null;
  headline: string;
  url: string | null;
  summary: string | null;
  original_headline: string | null;
  original_language: string | null;
  translation_confidence: number | null; // 0..1, null when not translated
};

async function closeBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best-effort cleanup only.
  }
}


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
        translation_confidence: null,

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
      // 0..1 self-reported confidence in the (detected language + translation).
      // Nullable/optional because older prompts / non-conforming outputs may skip it.
      confidence: z.number().nullable().optional(),
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
  confidence: number | null; // 0..1, null when unknown or no translation
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

// Warm the in-memory cache from the dedicated persistent translation cache
// so translations survive server restarts. Only rows whose `expires_at` is
// still in the future are honored — stale rows fall through to the LLM.
async function hydrateFromDbByOriginal(originals: string[]): Promise<void> {
  const missing = originals.filter((h) => !translationCache.has(h));
  if (missing.length === 0) return;
  try {
    const nowIso = new Date().toISOString();
    const { data } = await supabaseAdmin
      .from("headline_translation_cache")
      .select("source_headline, language, translation, confidence, expires_at")
      .in("source_headline", missing)
      .gt("expires_at", nowIso)
      .limit(500);
    for (const r of data ?? []) {
      const orig = (r as { source_headline: string }).source_headline;
      const lang = (r as { language: string | null }).language;
      const translation = (r as { translation: string | null }).translation;
      const conf = (r as { confidence: number | string | null }).confidence;
      if (!orig) continue;
      cacheSet(orig, {
        lang: lang ?? null,
        translation: translation ?? null,
        confidence: conf == null ? null : Number(conf),
      });
    }
  } catch (err) {
    // Non-fatal — the cache just stays cold for these keys.
    console.warn("news: cache hydrate failed", err instanceof Error ? err.message : String(err));
  }
}

// Persist fresh LLM results to the dedicated cache with a 30-day TTL
// (via the column default). Upsert so repeated appearances refresh
// `updated_at`/`expires_at` and keep hot entries alive.
async function persistTranslations(
  entries: { source: string; entry: TranslationCacheEntry }[],
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = entries.map(({ source, entry }) => ({
      source_headline: source,
      language: entry.lang,
      translation: entry.translation,
      confidence: entry.confidence,
      updated_at: nowIso,
      expires_at: expiresIso,
    }));
    const { error } = await supabaseAdmin
      .from("headline_translation_cache")
      .upsert(rows, { onConflict: "source_headline" });
    if (error) {
      console.warn("news: translation cache upsert failed", error.message);
    }
  } catch (err) {
    console.warn("news: translation cache upsert threw", err instanceof Error ? err.message : String(err));
  }
}

// Background refresh: find translation cache rows that have expired (or are
// within `soonMs` of expiring) and re-run the LLM so the persistent cache
// stays warm without waiting for a page read to trigger it. Bounded batch,
// best-effort, never throws. Called from the /api/public/hooks/translation-refresh
// cron endpoint.
const refreshInFlight = { p: null as Promise<{ scanned: number; refreshed: number }> | null };
export function refreshStaleTranslations(
  max = 50,
  soonMs = 24 * 60 * 60 * 1000, // also refresh anything expiring in next 24h
): Promise<{ scanned: number; refreshed: number }> {
  if (refreshInFlight.p) return refreshInFlight.p;
  const p = (async () => {
    try {
      const cutoffIso = new Date(Date.now() + soonMs).toISOString();
      const { data, error } = await supabaseAdmin
        .from("headline_translation_cache")
        .select("source_headline, expires_at")
        .lt("expires_at", cutoffIso)
        .order("expires_at", { ascending: true })
        .limit(max);
      if (error) {
        console.warn("news: stale translation scan failed", error.message);
        return { scanned: 0, refreshed: 0 };
      }
      const rows = data ?? [];
      if (rows.length === 0) return { scanned: 0, refreshed: 0 };

      const originals = rows
        .map((r) => (r as { source_headline: string }).source_headline)
        .filter((h): h is string => typeof h === "string" && h.length > 0);

      // Evict from memory so translateWithCache is forced to re-hit the LLM
      // instead of returning the about-to-expire entry.
      for (const h of originals) translationCache.delete(h);

      // Re-translate (in-memory + persistent cache both get rewritten with a
      // fresh 30-day TTL via persistTranslations).
      const fresh = await translateWithCache(originals);
      const refreshed = fresh.size;
      if (refreshed > 0) {
        console.log(`news: refreshed ${refreshed}/${rows.length} stale translations`);
      }
      return { scanned: rows.length, refreshed };
    } catch (err) {
      console.warn("news: stale refresh threw", err instanceof Error ? err.message : String(err));
      return { scanned: 0, refreshed: 0 };
    } finally {
      refreshInFlight.p = null;
    }
  })();
  refreshInFlight.p = p;
  return p;
}




async function callTranslateLLM(
  headlines: { i: number; text: string }[],
): Promise<Map<number, TranslationCacheEntry>> {
  const out = new Map<number, TranslationCacheEntry>();
  const key = process.env.LOVABLE_API_KEY;
  if (!key || headlines.length === 0) return out;

  const prompt = `For each numbered headline below, detect its language and, if it is NOT English, translate it into natural English. Use the full English name of the language (e.g. "Spanish", "Mandarin Chinese", "Macedonian"). When the headline is already in English, set lang to "English" and translation to null. Also return a "confidence" number between 0 and 1 (1 = certain, 0 = guessing). Never invent facts — translate only.

Reply with a single JSON object of the exact shape:
{"results":[{"i":<number>,"lang":"<language>","translation":"<english or null>","confidence":<0..1>}]}

Headlines:
${headlines.map((h) => `${h.i}. ${h.text}`).join("\n")}`;

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`news: translate LLM http ${res.status}: ${body.slice(0, 200)}`);
      return out;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    // Some gateways wrap JSON in ```json fences; strip them defensively.
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn(`news: translate LLM non-JSON reply: ${cleaned.slice(0, 200)}`);
      return out;
    }
    const validated = TranslateSchema.safeParse(parsed);
    if (!validated.success) {
      console.warn(`news: translate LLM schema mismatch: ${JSON.stringify(parsed).slice(0, 200)}`);
      return out;
    }
    for (const r of validated.data.results) {
      const rawConf = r.confidence;
      const conf =
        typeof rawConf === "number" && Number.isFinite(rawConf)
          ? Math.max(0, Math.min(1, rawConf))
          : null;
      out.set(r.i, {
        lang: (r.lang ?? "").trim() || null,
        translation: (r.translation ?? "")?.toString().trim() || null,
        confidence: conf,
      });
    }
  } catch (err) {
    console.warn("news: translate LLM failed", err instanceof Error ? err.message : String(err));
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

  // 3. LLM call for what's left, then persist in memory + durable cache.
  const numbered = truly.map((text, i) => ({ i, text }));
  const byIndex = await callTranslateLLM(numbered);
  const toPersist: { source: string; entry: TranslationCacheEntry }[] = [];
  for (let i = 0; i < truly.length; i++) {
    const entry = byIndex.get(i);
    if (!entry) continue;
    cacheSet(truly[i], entry);
    result.set(truly[i], entry);
    toPersist.push({ source: truly[i], entry });
  }
  await persistTranslations(toPersist);
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
      translation_confidence: t.confidence,
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
            translation_confidence: t.confidence,
          })
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



async function fetchGdeltQuery(
  dateISO: string,
  query: string,
  max: number,
  breakerName: string,
): Promise<NewsItem[] | null> {
  const day = dateISO.replace(/-/g, "");
  const start = `${day}000000`;
  const end = `${day}235959`;
  const encoded = encodeURIComponent(query);
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; LovableTrader/1.0)" };
  const dated = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encoded}&mode=ArtList&format=json&maxrecords=${max}&sort=hybridrel&startdatetime=${start}&enddatetime=${end}`;
  try {
    const res = await runWithBreaker(breakerName, () =>
      fetch(dated, { headers, signal: AbortSignal.timeout(6_000) }).then(async (r) => {
        if (!r.ok && (r.status >= 500 || r.status === 429)) {
          await closeBody(r);
          throw new Error(`${breakerName} transient ${r.status}`);
        }
        return r;
      }));
    if (res.ok) {
      const parsed = await parseGdeltResponse(res, dateISO);
      if (parsed && parsed.length > 0) return parsed.slice(0, max);
    } else {
      await closeBody(res);
    }
  } catch (err) {
    console.warn(
      `news: gdelt ${breakerName} dated fetch failed`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  if (dateISO !== today) return null;
  await new Promise((r) => setTimeout(r, 400));
  const fallback = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encoded}&mode=ArtList&format=json&maxrecords=${max}&sort=hybridrel&timespan=24h`;
  try {
    const res = await fetch(fallback, { headers, signal: AbortSignal.timeout(6_000) });
    if (!res.ok) {
      await closeBody(res);
      return null;
    }
    const parsed = await parseGdeltResponse(res, dateISO);
    return parsed ? parsed.slice(0, max) : null;
  } catch {
    return null;
  }
}

/**
 * Fan out across every configured GDELT topical slice in parallel, then
 * de-duplicate. Each slice contributes a bounded number of stories, so no
 * one topic can crowd out the others.
 */
async function fetchGdeltForDate(
  dateISO: string,
  max = 20,
): Promise<Array<NewsItem & { source_weight: number }> | null> {
  const { runWithBreaker } = await import("@/lib/_server/provider-circuit");
  void runWithBreaker; // circuit runner is referenced through fetchGdeltQuery
  const { GDELT_SOURCES } = await import("./news-sources");
  const perSliceMax = Math.max(3, Math.ceil(max / Math.max(1, GDELT_SOURCES.length)));
  const jobs = GDELT_SOURCES.map(async (src) => {
    const items = await fetchGdeltQuery(dateISO, src.query, perSliceMax, `gdelt:${src.id}`);
    if (!items) return [] as Array<NewsItem & { source_weight: number }>;
    return items.map((it) => ({ ...it, source_weight: src.weight }));
  });
  const settled = await Promise.all(jobs);
  const flat = settled.flat();
  if (flat.length === 0) {
    // Distinguish "all providers dead" from "no matches" — if every slice
    // returned null (not empty), signal upstream to keep the cache.
    const allNull = settled.every((s) => s.length === 0);
    return allNull ? null : flat;
  }
  return flat;
}


export async function getNewsForDate(
  dateISO: string,
  max = 15,
  opts?: { forceRefresh?: boolean },
): Promise<NewsItem[]> {
  const { data: cached } = await supabaseAdmin
    .from("news_cache")
    .select("news_date, source, headline, url, summary, original_headline, original_language, translation_confidence")
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
    translation_confidence:
      (r as { translation_confidence?: number | string | null }).translation_confidence == null
        ? null
        : Number((r as { translation_confidence: number | string }).translation_confidence),
  }));


  // Any cached non-English rows still missing a translation get repaired
  // synchronously. We used to `void` this as fire-and-forget, but on
  // Cloudflare Workers background promises are cancelled the instant the
  // response returns, so the LLM call never completed — cache stayed empty
  // and non-English headlines were displayed raw. Awaiting keeps the fix
  // durable; the pass is bounded (≤30 rows, one LLM call) so latency stays
  // in the low-seconds range even on the worst day.
  const untranslatedCount = cachedItems.filter(
    (c) => !c.original_language && looksNonEnglish(c.headline),
  ).length;
  if (untranslatedCount > 0) {
    try {
      await backfillTranslations(dateISO);
      // Re-read so the caller sees the newly-translated rows.
      const { data: refreshed } = await supabaseAdmin
        .from("news_cache")
        .select("news_date, source, headline, url, summary, original_headline, original_language, translation_confidence")
        .eq("news_date", dateISO)
        .limit(max);
      if (refreshed && refreshed.length > 0) {
        cachedItems.length = 0;
        for (const r of refreshed) {
          cachedItems.push({
            date: r.news_date as string,
            source: r.source,
            headline: r.headline,
            url: r.url,
            summary: r.summary,
            original_headline: (r as { original_headline?: string | null }).original_headline ?? null,
            original_language: (r as { original_language?: string | null }).original_language ?? null,
            translation_confidence:
              (r as { translation_confidence?: number | string | null }).translation_confidence == null
                ? null
                : Number((r as { translation_confidence: number | string }).translation_confidence),
          });
        }
      }
    } catch (err) {
      console.warn("news: inline backfill failed", err instanceof Error ? err.message : String(err));
    }
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
      translation_confidence: n.translation_confidence,

    }));
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("news_cache").insert(rows);
    if (error) console.error("news: cache insert failed", error);
  }
  return fresh;
}


