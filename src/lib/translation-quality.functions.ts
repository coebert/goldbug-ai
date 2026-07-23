// Admin/debug aggregator for translation confidence over time.
//
// Reads public.news_cache (shared reference data) and groups translation
// confidence by original_language × day, plus a top-N source breakdown to
// surface systematically low-confidence sources.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const FilterSchema = z.object({
  sinceDays: z.number().int().min(1).max(180).default(30),
  minCount: z.number().int().min(1).max(1000).default(3),
});

export type TranslationQualityFilter = z.input<typeof FilterSchema>;

export interface LanguageDayPoint {
  day: string; // YYYY-MM-DD
  avgConfidence: number;
  count: number;
  lowCount: number; // confidence < 0.6
}

export interface LanguageSeries {
  language: string;
  totalCount: number;
  avgConfidence: number;
  lowCount: number;
  lowShare: number; // 0..1
  points: LanguageDayPoint[];
}

export interface SourceQualityRow {
  source: string;
  language: string;
  count: number;
  avgConfidence: number;
  lowCount: number;
  lowShare: number;
}

export interface TranslationQualityResult {
  generatedAt: string;
  sinceDays: number;
  minCount: number;
  totalTranslated: number;
  overallAvgConfidence: number;
  languages: LanguageSeries[];
  worstSources: SourceQualityRow[];
  days: string[]; // sorted asc, covers full window
}

interface CacheRow {
  news_date: string | null;
  source: string | null;
  original_language: string | null;
  translation_confidence: number | string | null;
}

const LOW = 0.6;

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const getTranslationQuality = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => FilterSchema.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<TranslationQualityResult> => {
    const { supabase } = context;
    const since = new Date(Date.now() - data.sinceDays * 86400_000);
    const sinceDay = fmtDay(since);

    const { data: rows, error } = await supabase
      .from("news_cache")
      .select("news_date, source, original_language, translation_confidence")
      .not("translation_confidence", "is", null)
      .not("original_language", "is", null)
      .gte("news_date", sinceDay)
      .limit(20000);

    if (error) throw new Error(`translation-quality query failed: ${error.message}`);

    const cacheRows = (rows ?? []) as CacheRow[];

    // Build day axis
    const days: string[] = [];
    for (let i = data.sinceDays - 1; i >= 0; i--) {
      days.push(fmtDay(new Date(Date.now() - i * 86400_000)));
    }

    // language -> day -> {sum, count, low}
    const langMap = new Map<
      string,
      { total: number; sum: number; low: number; perDay: Map<string, { sum: number; count: number; low: number }> }
    >();
    // source|language -> agg
    const srcMap = new Map<
      string,
      { source: string; language: string; count: number; sum: number; low: number }
    >();

    let overallSum = 0;
    let overallCount = 0;

    for (const r of cacheRows) {
      const lang = (r.original_language ?? "unknown").toLowerCase();
      const conf = typeof r.translation_confidence === "string"
        ? Number(r.translation_confidence)
        : r.translation_confidence;
      if (conf == null || Number.isNaN(conf)) continue;
      const day = r.news_date ? dayKey(r.news_date) : null;
      if (!day) continue;

      overallSum += conf;
      overallCount += 1;

      let lang_ = langMap.get(lang);
      if (!lang_) {
        lang_ = { total: 0, sum: 0, low: 0, perDay: new Map() };
        langMap.set(lang, lang_);
      }
      lang_.total += 1;
      lang_.sum += conf;
      if (conf < LOW) lang_.low += 1;
      let dayBucket = lang_.perDay.get(day);
      if (!dayBucket) {
        dayBucket = { sum: 0, count: 0, low: 0 };
        lang_.perDay.set(day, dayBucket);
      }
      dayBucket.sum += conf;
      dayBucket.count += 1;
      if (conf < LOW) dayBucket.low += 1;

      const src = (r.source ?? "unknown").trim() || "unknown";
      const key = `${src}::${lang}`;
      let s = srcMap.get(key);
      if (!s) {
        s = { source: src, language: lang, count: 0, sum: 0, low: 0 };
        srcMap.set(key, s);
      }
      s.count += 1;
      s.sum += conf;
      if (conf < LOW) s.low += 1;
    }

    const languages: LanguageSeries[] = Array.from(langMap.entries())
      .map(([language, agg]) => {
        const points: LanguageDayPoint[] = days.map((d) => {
          const b = agg.perDay.get(d);
          return {
            day: d,
            count: b?.count ?? 0,
            lowCount: b?.low ?? 0,
            avgConfidence: b && b.count > 0 ? b.sum / b.count : 0,
          };
        });
        return {
          language,
          totalCount: agg.total,
          avgConfidence: agg.total > 0 ? agg.sum / agg.total : 0,
          lowCount: agg.low,
          lowShare: agg.total > 0 ? agg.low / agg.total : 0,
          points,
        };
      })
      .sort((a, b) => b.totalCount - a.totalCount);

    const worstSources: SourceQualityRow[] = Array.from(srcMap.values())
      .filter((s) => s.count >= data.minCount)
      .map((s) => ({
        source: s.source,
        language: s.language,
        count: s.count,
        avgConfidence: s.sum / s.count,
        lowCount: s.low,
        lowShare: s.low / s.count,
      }))
      .sort((a, b) => a.avgConfidence - b.avgConfidence)
      .slice(0, 20);

    return {
      generatedAt: new Date().toISOString(),
      sinceDays: data.sinceDays,
      minCount: data.minCount,
      totalTranslated: overallCount,
      overallAvgConfidence: overallCount > 0 ? overallSum / overallCount : 0,
      languages,
      worstSources,
      days,
    };
  });
