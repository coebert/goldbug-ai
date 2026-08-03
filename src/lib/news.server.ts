// Lightweight global news fetcher. Draws from GDELT DOC (topical slices)
// and a diversified list of public RSS feeds so no single wire dominates.
// Caches results by date in news_cache.

import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runWithBreaker } from "@/lib/_server/provider-circuit";
import { GDELT_SOURCES } from "./news-sources";
import { fetchRssForDate } from "./news-rss.server";
import { buildSeenKeySet, filterUnseen, normalizeHeadlineKey } from "./news-dedupe";
import { detectLanguage, needsTranslation } from "./language-detect";
import { createConsoleLogger } from "@/lib/_server/log";

const srvLog = createConsoleLogger("news");





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
    srvLog.warn(`news: gdelt returned non-JSON (likely rate-limited): ${snippet}`);
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
    srvLog.error("news: gdelt JSON parse failed", err);
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


// Language gate for the translation pipeline. Previously this was a bare
// non-ASCII test, which silently passed over every Latin-script non-English
// headline ("Governo aprova novo imposto"). It now delegates to the shared
// deterministic detector, which combines script detection, per-language
// function-word markers and diacritic evidence, with English function-word
// density as counter-evidence. The LLM still has the final say on the
// language name and the translation — this only decides whether to ask.
export function looksNonEnglish(s: string): boolean {
  return needsTranslation(s);
}

/** Re-exported so read paths can label an item consistently without an LLM. */
export { detectLanguage };


/** Deterministic display name for a headline's language, or null if unknown. */
function detectLanguageName(s: string): string | null {
  const d = detectLanguage(s);
  return d.isEnglish ? null : d.name;
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
//   2. In-memory per-worker LRU keyed by the NORMALISED headline key — the
//      same story arriving with different casing, punctuation or a wire
//      prefix ("UPDATE 2-…") reuses one translation instead of paying for a
//      second LLM call.
//   3. Durable `headline_translation_cache`, also keyed on that normalised
//      key (`norm_key`, uniquely indexed), so cron runs and refreshes across
//      workers/restarts never retranslate a story already translated.
//   4. In-flight de-duplication on `backfillTranslations(dateISO)` so many
//      concurrent renders sharing a request don't stampede the LLM.

type TranslationCacheEntry = {
  lang: string | null; // null = English (or unknown/no-translate)
  translation: string | null; // null = no translation needed
  confidence: number | null; // 0..1, null when unknown or no translation
};

/**
 * Cache key for a headline: the shared normalised dedupe key, so cache hits
 * survive punctuation/casing/wire-prefix drift. Falls back to the trimmed raw
 * text when normalisation yields nothing (e.g. emoji-only headlines).
 */
export function translationCacheKey(headline: string): string {
  return normalizeHeadlineKey(headline) || headline.trim().toLowerCase();
}

const TRANSLATION_CACHE_MAX = 2000;
const translationCache = new Map<string, TranslationCacheEntry>();

function cacheGet(headline: string): TranslationCacheEntry | undefined {
  const key = translationCacheKey(headline);
  const hit = translationCache.get(key);
  if (!hit) return undefined;
  // LRU touch — reinserting moves it to newest position.
  translationCache.delete(key);
  translationCache.set(key, hit);
  return hit;
}

function cacheSet(headline: string, entry: TranslationCacheEntry): void {
  const key = translationCacheKey(headline);
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, entry);
  if (translationCache.size > TRANSLATION_CACHE_MAX) {
    // Evict oldest.
    const oldest = translationCache.keys().next().value;
    if (oldest !== undefined) translationCache.delete(oldest);
  }
}

function cacheDelete(headline: string): void {
  translationCache.delete(translationCacheKey(headline));
}

// Warm the in-memory cache from the dedicated persistent translation cache
// so translations survive server restarts. Only rows whose `expires_at` is
// still in the future are honored — stale rows fall through to the LLM.
// Lookups go through `norm_key`, so a story whose punctuation/casing changed
// between runs still resolves to the stored translation.
async function hydrateFromDbByOriginal(originals: string[]): Promise<void> {
  const missing = originals.filter((h) => !translationCache.has(translationCacheKey(h)));
  if (missing.length === 0) return;
  const keys = Array.from(new Set(missing.map(translationCacheKey))).filter(Boolean);
  if (keys.length === 0) return;
  try {
    const nowIso = new Date().toISOString();
    const { data } = await supabaseAdmin
      .from("headline_translation_cache")
      .select("source_headline, norm_key, language, translation, confidence, expires_at")
      .in("norm_key", keys)
      .gt("expires_at", nowIso)
      .limit(500);
    const byKey = new Map<string, TranslationCacheEntry>();
    for (const r of data ?? []) {
      const row = r as {
        source_headline: string | null;
        norm_key: string | null;
        language: string | null;
        translation: string | null;
        confidence: number | string | null;
      };
      const key = row.norm_key || (row.source_headline ? translationCacheKey(row.source_headline) : "");
      if (!key) continue;
      byKey.set(key, {
        lang: row.language ?? null,
        translation: row.translation ?? null,
        confidence: row.confidence == null ? null : Number(row.confidence),
      });
    }
    for (const h of missing) {
      const hit = byKey.get(translationCacheKey(h));
      if (hit) cacheSet(h, hit);
    }
  } catch (err) {
    // Non-fatal — the cache just stays cold for these keys.
    srvLog.warn("news: cache hydrate failed", err instanceof Error ? err.message : String(err));
  }
}

// Persist fresh LLM results to the dedicated cache with a 30-day TTL.
// Upsert on `norm_key` so repeated appearances of the same story (any
// punctuation/casing variant) refresh one row rather than adding duplicates.
async function persistTranslations(
  entries: { source: string; entry: TranslationCacheEntry }[],
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    // Collapse variants inside this batch — the unique index rejects a batch
    // containing two rows with the same norm_key.
    const byKey = new Map<string, { source: string; entry: TranslationCacheEntry }>();
    for (const e of entries) {
      const key = translationCacheKey(e.source);
      if (!key) continue;
      byKey.set(key, e);
    }
    const rows = Array.from(byKey.entries()).map(([norm_key, { source, entry }]) => ({
      source_headline: source,
      norm_key,
      language: entry.lang,
      translation: entry.translation,
      confidence: entry.confidence,
      updated_at: nowIso,
      expires_at: expiresIso,
    }));
    if (rows.length === 0) return;
    const { error } = await supabaseAdmin
      .from("headline_translation_cache")
      .upsert(rows, { onConflict: "norm_key" });
    if (error) {
      srvLog.warn("news: translation cache upsert failed", error.message);
    }
  } catch (err) {
    srvLog.warn("news: translation cache upsert threw", err instanceof Error ? err.message : String(err));
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
        srvLog.warn("news: stale translation scan failed", error.message);
        return { scanned: 0, refreshed: 0 };
      }
      const rows = data ?? [];
      if (rows.length === 0) return { scanned: 0, refreshed: 0 };

      const originals = rows
        .map((r) => (r as { source_headline: string }).source_headline)
        .filter((h): h is string => typeof h === "string" && h.length > 0);

      // Evict from memory so translateWithCache is forced to re-hit the LLM
      // instead of returning the about-to-expire entry.
      for (const h of originals) cacheDelete(h);

      // Re-translate (in-memory + persistent cache both get rewritten with a
      // fresh 30-day TTL via persistTranslations).
      const fresh = await translateWithCache(originals);
      const refreshed = fresh.size;
      if (refreshed > 0) {
        srvLog.log(`news: refreshed ${refreshed}/${rows.length} stale translations`);
      }
      return { scanned: rows.length, refreshed };
    } catch (err) {
      srvLog.warn("news: stale refresh threw", err instanceof Error ? err.message : String(err));
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
      srvLog.warn(`news: translate LLM http ${res.status}: ${body.slice(0, 200)}`);
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
      srvLog.warn(`news: translate LLM non-JSON reply: ${cleaned.slice(0, 200)}`);
      return out;
    }
    const validated = TranslateSchema.safeParse(parsed);
    if (!validated.success) {
      srvLog.warn(`news: translate LLM schema mismatch: ${JSON.stringify(parsed).slice(0, 200)}`);
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
    srvLog.warn("news: translate LLM failed", err instanceof Error ? err.message : String(err));
  }
  return out;
}


// Batch-translate with caching. Cached entries never hit the LLM;
// remaining items are batched into a single gateway call.
async function translateWithCache(
  headlines: string[],
): Promise<Map<string, TranslationCacheEntry>> {
  const byKey = new Map<string, TranslationCacheEntry>();
  if (headlines.length === 0) return new Map();

  // De-duplicate on the NORMALISED key, so punctuation/casing variants of the
  // same story share one cache lookup and one LLM slot.
  const repByKey = new Map<string, string>();
  for (const h of headlines) {
    const k = translationCacheKey(h);
    if (!k || repByKey.has(k)) continue;
    repByKey.set(k, h);
  }
  const uniq = Array.from(repByKey.values());

  // 1. Memory cache.
  const stillMissing: string[] = [];
  for (const h of uniq) {
    const hit = cacheGet(h);
    if (hit) byKey.set(translationCacheKey(h), hit);
    else stillMissing.push(h);
  }

  // 2. Persistent cache — translations of the same story stored on another
  //    date/source, or by an earlier cron run/worker.
  if (stillMissing.length > 0) {
    await hydrateFromDbByOriginal(stillMissing);
  }
  const truly: string[] = [];
  for (const h of stillMissing) {
    const hit = cacheGet(h);
    if (hit) byKey.set(translationCacheKey(h), hit);
    else truly.push(h);
  }

  // 3. LLM call for what's left, then persist in memory + durable cache.
  if (truly.length > 0) {
    const numbered = truly.map((text, i) => ({ i, text }));
    const byIndex = await callTranslateLLM(numbered);
    const toPersist: { source: string; entry: TranslationCacheEntry }[] = [];
    for (let i = 0; i < truly.length; i++) {
      const entry = byIndex.get(i);
      if (!entry) continue;
      cacheSet(truly[i], entry);
      byKey.set(translationCacheKey(truly[i]), entry);
      toPersist.push({ source: truly[i], entry });
    }
    await persistTranslations(toPersist);
  }

  // Fan the per-key results back out to every input headline variant.
  const result = new Map<string, TranslationCacheEntry>();
  for (const h of headlines) {
    const hit = byKey.get(translationCacheKey(h));
    if (hit) result.set(h, hit);
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
    // Label consistency: if the model translated but did not name the
    // language, fall back to the deterministic detector so the same headline
    // is always presented with the same "Translated from X" label.
    const detected = detectLanguageName(it.headline);
    return {
      ...it,
      headline: t.translation,
      original_headline: it.headline,
      original_language: t.lang ?? detected,
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
            original_language: t.lang ?? detectLanguageName(originalHeadline),
            translation_confidence: t.confidence,
          })
          .eq("news_date", dateISO)
          .eq("headline", originalHeadline);

        if (!error) translated++;
      }
      if (translated > 0) {
        srvLog.log(`news: backfilled ${translated}/${rows.length} translations for ${dateISO}`);
      }
      return { scanned: rows.length, translated };
    } catch (err) {
      srvLog.warn("news: backfill threw", err instanceof Error ? err.message : String(err));
      return { scanned: 0, translated: 0 };
    } finally {
      backfillInFlight.delete(dateISO);
    }
  })();
  backfillInFlight.set(dateISO, p);
  return p;
}




// ---------------------------------------------------------------------------
// GDELT retry / backoff helper
// ---------------------------------------------------------------------------
// GDELT DOC returns HTTP 200 with a plain-text body ("Please limit requests
// to no more than one every 5 seconds…") when the client is throttled,
// **and** occasionally returns an actual HTTP 429. Both must trigger a
// bounded retry with exponential backoff so a single throttled slice
// doesn't silently produce zero headlines for the whole run.
//
// Behaviour:
//   • up to GDELT_MAX_ATTEMPTS attempts per URL (initial + retries)
//   • honours a `Retry-After` header when the server supplies one
//   • otherwise waits `base * 2^(attempt-1)` with ±25% jitter, capped at
//     GDELT_MAX_BACKOFF_MS
//   • retries on: 429, 5xx, fetch/timeout errors, and the plain-text
//     rate-limit sentinel body detected by parseGdeltResponse (null return)
//   • gives up loudly with a single console.warn identifying the URL and
//     final failure mode so a run's news_ingest logs always show *why*
//     GDELT contributed nothing.

const GDELT_MAX_ATTEMPTS = 4;
const GDELT_BASE_BACKOFF_MS = 1_500;
const GDELT_MAX_BACKOFF_MS = 8_000;
const GDELT_FETCH_TIMEOUT_MS = 5_000;
const GDELT_REFRESH_BUDGET_MS = 18_000;

function computeBackoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(GDELT_MAX_BACKOFF_MS * 2, Math.floor(secs * 1_000));
    }
    const dateMs = Date.parse(retryAfterHeader);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      if (delta > 0) return Math.min(GDELT_MAX_BACKOFF_MS * 2, delta);
    }
  }
  const raw = GDELT_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = raw * (0.75 + Math.random() * 0.5);
  return Math.min(GDELT_MAX_BACKOFF_MS, Math.floor(jitter));
}

type GdeltFetchResult =
  | { kind: "ok"; items: NewsItem[] }
  | { kind: "empty" }
  | { kind: "failed"; reason: string };

async function fetchGdeltWithRetry(
  url: string,
  dateISO: string,
  breakerName: string,
  headers: Record<string, string>,
  deadlineAt?: number,
): Promise<GdeltFetchResult> {
  let lastReason = "unknown";
  for (let attempt = 1; attempt <= GDELT_MAX_ATTEMPTS; attempt++) {
    const remainingMs = deadlineAt ? deadlineAt - Date.now() : GDELT_FETCH_TIMEOUT_MS;
    if (remainingMs < 1_500) {
      lastReason = "refresh budget exceeded";
      break;
    }
    const timeoutMs = Math.max(1_500, Math.min(GDELT_FETCH_TIMEOUT_MS, remainingMs - 250));
    try {
      const res = await runWithBreaker(breakerName, () =>
        fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }),
      );

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get("retry-after");
        await closeBody(res);
        lastReason = `http ${res.status}`;
        if (attempt < GDELT_MAX_ATTEMPTS) {
          const budgetWait = deadlineAt ? Math.max(0, deadlineAt - Date.now() - 500) : GDELT_MAX_BACKOFF_MS;
          const wait = Math.min(computeBackoffMs(attempt, retryAfter), budgetWait);
          if (wait <= 0) break;
          srvLog.warn(
            `news: gdelt ${breakerName} ${lastReason} — backoff ${wait}ms (attempt ${attempt}/${GDELT_MAX_ATTEMPTS})`,
          );
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        break;
      }

      if (!res.ok) {
        await closeBody(res);
        lastReason = `http ${res.status}`;
        break; // non-retriable client error (4xx other than 429)
      }

      const parsed = await parseGdeltResponse(res, dateISO);
      if (parsed === null) {
        // Plain-text rate-limit sentinel body — treat as soft 429.
        lastReason = "text rate-limit body";
        if (attempt < GDELT_MAX_ATTEMPTS) {
          const budgetWait = deadlineAt ? Math.max(0, deadlineAt - Date.now() - 500) : GDELT_MAX_BACKOFF_MS;
          const wait = Math.min(computeBackoffMs(attempt, null), budgetWait);
          if (wait <= 0) break;
          srvLog.warn(
            `news: gdelt ${breakerName} throttled body — backoff ${wait}ms (attempt ${attempt}/${GDELT_MAX_ATTEMPTS})`,
          );
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        break;
      }
      return parsed.length > 0 ? { kind: "ok", items: parsed } : { kind: "empty" };
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
      if (attempt < GDELT_MAX_ATTEMPTS) {
        const budgetWait = deadlineAt ? Math.max(0, deadlineAt - Date.now() - 500) : GDELT_MAX_BACKOFF_MS;
        const wait = Math.min(computeBackoffMs(attempt, null), budgetWait);
        if (wait <= 0) break;
        srvLog.warn(
          `news: gdelt ${breakerName} threw "${lastReason}" — backoff ${wait}ms (attempt ${attempt}/${GDELT_MAX_ATTEMPTS})`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
    }
  }
  srvLog.warn(
    `news: gdelt ${breakerName} gave up after ${GDELT_MAX_ATTEMPTS} attempts — reason: ${lastReason} — url: ${url}`,
  );
  return { kind: "failed", reason: lastReason };
}

async function fetchGdeltQuery(
  dateISO: string,
  query: string,
  max: number,
  breakerName: string,
  deadlineAt: number,
): Promise<NewsItem[] | null> {
  const day = dateISO.replace(/-/g, "");
  const start = `${day}000000`;
  const end = `${day}235959`;
  const encoded = encodeURIComponent(query);
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; LovableTrader/1.0)" };
  const dated = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encoded}&mode=ArtList&format=json&maxrecords=${max}&sort=hybridrel&startdatetime=${start}&enddatetime=${end}`;

  const primary = await fetchGdeltWithRetry(dated, dateISO, breakerName, headers, deadlineAt);
  if (primary.kind === "ok") return primary.items.slice(0, max);
  // "empty" from the dated window on prior days is a real answer (no news),
  // so only fall through to the 24h fallback for today's date.
  const today = new Date().toISOString().slice(0, 10);
  if (dateISO !== today) {
    return primary.kind === "failed" ? null : [];
  }
  if (deadlineAt - Date.now() < 2_000) return primary.kind === "failed" ? null : [];

  await new Promise((r) => setTimeout(r, 400));
  const fallback = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encoded}&mode=ArtList&format=json&maxrecords=${max}&sort=hybridrel&timespan=24h`;
  const fb = await fetchGdeltWithRetry(fallback, dateISO, `${breakerName}:24h`, headers, deadlineAt);
  if (fb.kind === "ok") return fb.items.slice(0, max);
  if (fb.kind === "empty") return [];
  return null;
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
  const perSliceMax = Math.max(3, Math.ceil(max / Math.max(1, GDELT_SOURCES.length)));
  // GDELT enforces "≤1 request every 5 seconds" per client. Fan-out in
  // parallel caused every slice to 429 and abort, so slices are serialised
  // with pacing. With more slices than fit in one budget window, we rotate
  // the starting offset by the hour so every topic gets covered across
  // successive refreshes instead of the tail never running.
  const flat: Array<NewsItem & { source_weight: number }> = [];
  let anyReturnedNonNull = false;
  const deadlineAt = Date.now() + GDELT_REFRESH_BUDGET_MS;
  const offset = GDELT_SOURCES.length > 0
    ? Math.floor(Date.now() / 3_600_000) % GDELT_SOURCES.length
    : 0;
  for (let n = 0; n < GDELT_SOURCES.length; n++) {
    const src = GDELT_SOURCES[(offset + n) % GDELT_SOURCES.length];
    if (deadlineAt - Date.now() < 2_000) {
      srvLog.warn(`news: gdelt budget exhausted after ${n}/${GDELT_SOURCES.length} slices (offset ${offset})`);
      break;
    }
    if (n > 0) {
      const pause = Math.min(5_500, Math.max(0, deadlineAt - Date.now() - 2_000));
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    }
    const items = await fetchGdeltQuery(dateISO, src.query, perSliceMax, `gdelt:${src.id}`, deadlineAt);
    if (items) {
      anyReturnedNonNull = true;
      for (const it of items) flat.push({ ...it, source_weight: src.weight });
    }
  }

  if (flat.length === 0 && !anyReturnedNonNull) return null;
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
      srvLog.warn("news: inline backfill failed", err instanceof Error ? err.message : String(err));
    }
  }

  // Use existing cache when we're not forcing a refresh and it looks healthy.
  if (!opts?.forceRefresh && cachedItems.length >= 5) return cachedItems;

  // Fan out across every configured provider family in parallel — GDELT
  // topical slices + curated RSS feeds. GDELT is useful but can be slow or
  // aggressively throttled; its own global budget above prevents it from
  // blocking the RSS-backed feed or the trading tick.
  const [gdeltResult, rssResult] = await Promise.all([
    fetchGdeltForDate(dateISO, max),
    fetchRssForDate(dateISO, 4).catch((err) => {
      srvLog.warn("news: rss fan-out threw", err instanceof Error ? err.message : String(err));
      return [] as Array<NewsItem & { source_weight: number }>;
    }),
  ]);

  const gdelt = gdeltResult ?? [];
  const combined = [...gdelt, ...rssResult];

  if (combined.length === 0) {
    srvLog.warn(`news: keeping ${cachedItems.length} cached rows for ${dateISO} (all providers unavailable)`);
    return cachedItems;
  }

  // De-duplicate across sources by URL first (canonical), then normalised
  // headline. Enforce a per-domain diversity cap so a single wire cannot
  // dominate the reel. Weights break ties so tier-one wires beat regional
  // aggregators for the same story.
  const PER_DOMAIN_MAX = 3;
  combined.sort((a, b) => (b.source_weight ?? 0) - (a.source_weight ?? 0));
  const byUrl = new Set<string>();
  const byHead = new Set<string>();
  const perDomain = new Map<string, number>();
  const merged: Array<NewsItem & { source_weight: number }> = [];
  for (const it of combined) {
    const urlKey = (it.url ?? "").split("?")[0].toLowerCase();
    const headKey = it.headline.toLowerCase().replace(/\s+/g, " ").trim();
    if (urlKey && byUrl.has(urlKey)) continue;
    if (byHead.has(headKey)) continue;
    const domain = (it.source ?? "").toLowerCase();
    const dcount = perDomain.get(domain) ?? 0;
    if (domain && dcount >= PER_DOMAIN_MAX) continue;
    if (urlKey) byUrl.add(urlKey);
    byHead.add(headKey);
    if (domain) perDomain.set(domain, dcount + 1);
    merged.push(it);
    if (merged.length >= max * 2) break; // cap fan-in before translation
  }

  // Translate before writing so the cache holds English + original metadata.
  const translated = await translateHeadlines(merged);
  // Re-attach source_weight after translation (translateHeadlines strips
  // extra fields on the object spread path).
  const fresh: Array<NewsItem & { source_weight: number }> = translated.map((t, i) => ({
    ...t,
    source_weight: merged[i]?.source_weight ?? 0.5,
  }));

  // We have a real fresh set. Only NOW do we replace today's rows on
  // forceRefresh; otherwise merge (skip duplicates).
  if (opts?.forceRefresh) {
    await supabaseAdmin.from("news_cache").delete().eq("news_date", dateISO);
  }

  // De-dupe against everything already cached in the reel's visible window,
  // not just today's rows: GDELT/RSS re-publish the same story on consecutive
  // days, so a date-scoped check let cron insert visible repeats.
  const windowStart = new Date(Date.parse(`${dateISO}T00:00:00Z`) - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data: recentRows } = await supabaseAdmin
    .from("news_cache")
    .select("headline, url, original_headline")
    .gte("news_date", windowStart)
    .limit(1000);
  const seen = buildSeenKeySet([
    ...(recentRows ?? []).map((r) => ({
      headline: (r.headline as string) ?? "",
      url: (r.url as string | null) ?? null,
      original_headline: (r as { original_headline?: string | null }).original_headline ?? null,
    })),
    // forceRefresh already deleted today's rows above, so don't re-block them.
    ...(opts?.forceRefresh ? [] : cachedItems),
  ]);
  const rows = filterUnseen(fresh, seen).map((n) => ({
      news_date: n.date,
      source: n.source,
      headline: n.headline,
      url: n.url,
      summary: n.summary,
      original_headline: n.original_headline,
      original_language: n.original_language,
      translation_confidence: n.translation_confidence,
      source_weight: n.source_weight,
    }));
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("news_cache").insert(rows);
    if (error) srvLog.error("news: cache insert failed", error);
  }
  return fresh;
}



