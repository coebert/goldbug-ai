// Server-only helpers, schemas, and internal types for the translation-quality
// aggregator. Extracted from translation-quality.functions.ts so the wrapper
// stays a thin server-fn module (see tanstack-serverfn-splitting knowledge).

import { z } from "zod";

export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export const TranslationQualityFilterSchema = z.object({
  sinceDays: z.number().int().min(1).max(180).default(30),
  minCount: z.number().int().min(1).max(1000).default(3),
});

export type TranslationQualityFilterInput = z.input<typeof TranslationQualityFilterSchema>;

export interface CacheRow {
  news_date: string | null;
  source: string | null;
  original_language: string | null;
  translation_confidence: number | string | null;
}

export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
