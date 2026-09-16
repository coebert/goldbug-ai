// LLM-scored news sentiment. Replaces keyword matching.
// - Uses gemini-3.1-flash-lite for cost.
// - Caches results directly on news_cache (sentiment, entities, source_weight).
// - Applies source weighting and exponential recency decay when aggregating.

import { generateText } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/_server/db-json";
import type { NewsItem } from "./news.server";

// Source reputation weights. Tier-1 wires get the highest signal;
// aggregators / SEO farms get the lowest.
const SOURCE_WEIGHTS: Array<[RegExp, number]> = [
  [/reuters\.com/i, 1.0],
  [/bloomberg\./i, 1.0],
  [/ft\.com/i, 0.95],
  [/wsj\.com/i, 0.95],
  [/economist\.com/i, 0.9],
  [/nytimes\.com/i, 0.85],
  [/cnbc\.com/i, 0.8],
  [/bbc\.co\.uk|bbc\.com/i, 0.8],
  [/theguardian\.com/i, 0.75],
  [/apnews\.com/i, 0.85],
  [/marketwatch\.com/i, 0.7],
  [/yahoo\.com/i, 0.5],
  [/seekingalpha\.com/i, 0.5],
  [/investing\.com/i, 0.5],
];

export function sourceWeight(source: string | null | undefined): number {
  if (!source) return 0.4;
  for (const [rx, w] of SOURCE_WEIGHTS) if (rx.test(source)) return w;
  return 0.4; // unknown / aggregator default
}

const HeadlineScoreSchema = z.object({
  scores: z.array(
    z.object({
      i: z.number().optional(),
      sentiment: z.number(), // -1..+1
      entities: z.array(z.string()), // tickers, companies, macro topics
    }),
  ),
});

function parseScorePayload(
  raw: string,
  requested: { i: number }[],
): Array<{ i: number; sentiment: number; entities: string[] }> {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned) as unknown;
  const normalized = Array.isArray(parsed) ? { scores: parsed } : parsed;
  const result = HeadlineScoreSchema.safeParse(normalized);
  if (!result.success) return [];
  return result.data.scores.flatMap((score, idx) => {
    const originalIndex = score.i ?? requested[idx]?.i;
    if (originalIndex == null) return [];
    return [{ i: originalIndex, sentiment: score.sentiment, entities: score.entities }];
  });
}

async function scoreBatch(
  items: { i: number; headline: string; source: string | null }[],
): Promise<Map<number, { sentiment: number; entities: string[] }>> {
  const key = process.env.LOVABLE_API_KEY;
  const out = new Map<number, { sentiment: number; entities: string[] }>();
  if (!key || items.length === 0) return out;

  const gateway = createLovableAiGatewayProvider(key);
  const model = gateway("google/gemini-3.1-flash-lite");

  const prompt = `Score each financial news headline for market sentiment on -1 (very bearish) to +1 (very bullish), 0 = neutral. Extract entities as short uppercase strings (tickers or company/topic names). Reply only as JSON in this exact shape: {"scores":[{"i":0,"sentiment":0,"entities":["EXAMPLE"]}]}.

Headlines:
${items.map((it) => `${it.i}. [${it.source ?? "unknown"}] ${it.headline}`).join("\n")}`;

  try {
    const { text } = await generateText({
      model,
      prompt,
    });
    for (const s of parseScorePayload(text, items)) {
      const clamped = Math.max(-1, Math.min(1, Number(s.sentiment) || 0));
      const ents = Array.isArray(s.entities)
        ? s.entities.map((e) => String(e).toUpperCase().slice(0, 24)).slice(0, 8)
        : [];
      out.set(s.i, { sentiment: clamped, entities: ents });
    }
  } catch (err) {
    console.warn("sentiment: LLM scoring failed", err);
  }
  return out;
}

/**
 * Ensure the given news items have sentiment + entities + source_weight
 * persisted in news_cache. Items already scored are left alone.
 * Mutates the returned array to include the scores.
 */
export async function ensureSentimentScored(
  dateISO: string,
  items: NewsItem[],
): Promise<
  Array<
    NewsItem & {
      sentiment: number | null;
      entities: string[];
      source_weight: number;
    }
  >
> {
  // Fetch existing scores from cache
  const { data: rows } = await supabaseAdmin
    .from("news_cache")
    .select("headline, sentiment, entities, source_weight")
    .eq("news_date", dateISO);

  const byHead = new Map<
    string,
    { sentiment: number | null; entities: string[]; source_weight: number | null }
  >();
  for (const r of rows ?? []) {
    byHead.set(r.headline, {
      sentiment: r.sentiment == null ? null : Number(r.sentiment),
      entities: Array.isArray(r.entities) ? (r.entities as string[]) : [],
      source_weight: r.source_weight == null ? null : Number(r.source_weight),
    });
  }

  const enriched = items.map((n, idx) => {
    const cached = byHead.get(n.headline);
    return {
      ...n,
      _idx: idx,
      sentiment: cached?.sentiment ?? null,
      entities: cached?.entities ?? [],
      source_weight: cached?.source_weight ?? sourceWeight(n.source),
    };
  });

  const needScoring = enriched
    .filter((e) => e.sentiment == null)
    .map((e) => ({ i: e._idx, headline: e.headline, source: e.source }));

  if (needScoring.length > 0) {
    // Batch 15 at a time to keep prompt small
    for (let i = 0; i < needScoring.length; i += 15) {
      const batch = needScoring.slice(i, i + 15);
      const scored = await scoreBatch(batch);
      for (const b of batch) {
        const s = scored.get(b.i);
        if (!s) continue;
        const e = enriched.find((x) => x._idx === b.i);
        if (!e) continue;
        e.sentiment = s.sentiment;
        e.entities = s.entities;
      }
    }
  }

  // Persist any newly-scored rows (upsert by headline within the date).
  const toUpdate = enriched.filter((e) => e.sentiment != null);
  for (const e of toUpdate) {
    await supabaseAdmin
      .from("news_cache")
      .update({
        sentiment: e.sentiment as unknown as string,
        entities: asJson(e.entities),
        source_weight: e.source_weight as unknown as number,
      })
      .eq("news_date", dateISO)
      .eq("headline", e.headline);
  }

  return enriched.map(({ _idx, ...rest }) => rest);
}

/**
 * Aggregate weighted sentiment for a symbol.
 * Weight = source_weight × recency_decay (24h half-life) × entity_match_boost.
 */
export function aggregatedSentimentForSymbol(
  symbol: string,
  name: string,
  scoredNews: Array<{
    headline: string;
    source: string | null;
    sentiment: number | null;
    entities: string[];
    source_weight: number;
    date?: string;
  }>,
  asOfISO: string,
): { score: number; contributors: number } {
  const asOfMs = new Date(asOfISO + "T23:59:59Z").getTime();
  const halfLifeMs = 24 * 3600 * 1000;
  const sym = symbol.toUpperCase();
  const firstName = name.split(/\s+/)[0]?.toUpperCase() ?? "";

  let num = 0;
  let denom = 0;
  let contributors = 0;

  for (const n of scoredNews) {
    if (n.sentiment == null) continue;
    const entityMatch =
      n.entities.some((e) => e === sym) ||
      (firstName.length > 3 && n.entities.some((e) => e.includes(firstName)));
    const headlineMatch =
      n.headline.toUpperCase().includes(sym) ||
      (firstName.length > 3 && n.headline.toUpperCase().includes(firstName));
    if (!entityMatch && !headlineMatch) continue;
    const entityBoost = entityMatch ? 1.5 : 1.0;
    let recencyW = 1.0;
    if (n.date) {
      const ageMs = Math.max(0, asOfMs - new Date(n.date + "T12:00:00Z").getTime());
      recencyW = Math.pow(0.5, ageMs / halfLifeMs);
    }
    const w = n.source_weight * recencyW * entityBoost;
    num += n.sentiment * w;
    denom += w;
    contributors += 1;
  }
  return { score: denom > 0 ? num / denom : 0, contributors };
}

type ScoredCacheRow = {
  news_date: string;
  source: string | null;
  url: string | null;
  headline: string;
  sentiment: number | null;
  entities: string[];
  source_weight: number;
};

/**
 * Load already-scored news across a rolling lookback window for momentum
 * calculations. We only take rows that already have a sentiment score —
 * momentum should not trigger fresh LLM scoring of historical days.
 */
export async function loadScoredNewsWindow(
  asOfISO: string,
  lookbackDays: number,
): Promise<ScoredCacheRow[]> {
  const end = new Date(asOfISO + "T00:00:00Z");
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  const startISO = start.toISOString().slice(0, 10);
  const { data } = await supabaseAdmin
    .from("news_cache")
    .select("news_date, source, url, headline, sentiment, entities, source_weight")
    .gte("news_date", startISO)
    .lte("news_date", asOfISO)
    .not("sentiment", "is", null)
    .limit(2000);
  return (data ?? []).map((r) => ({
    news_date: r.news_date as string,
    source: (r.source as string | null) ?? null,
    url: ((r as { url?: string | null }).url as string | null) ?? null,
    headline: r.headline as string,
    sentiment: r.sentiment == null ? null : Number(r.sentiment),
    entities: Array.isArray(r.entities) ? (r.entities as string[]) : [],
    source_weight: r.source_weight == null ? 0.4 : Number(r.source_weight),
  }));
}

export type SentimentMomentum = {
  today: number | null;
  avg_3d: number | null;
  avg_7d: number | null;
  delta_3d: number | null; // today - avg_7d (short-term surge vs baseline)
  delta_7d: number | null; // avg_3d - avg_7d (medium-term drift)
  accel: number | null; // delta_3d - delta_7d (acceleration)
  contributors_7d: number;
};

function addDaysISO(iso: string, delta: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function mean(vals: number[]): number | null {
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Compute sentiment momentum for a symbol from the scored-news window.
 * Groups by date, aggregates per-symbol daily sentiment with the same
 * weighted method as spot sentiment, then diffs short vs long averages.
 */
export function computeSentimentMomentum(
  symbol: string,
  name: string,
  scoredWindow: ScoredCacheRow[],
  asOfISO: string,
): SentimentMomentum {
  const byDate = new Map<string, ScoredCacheRow[]>();
  for (const r of scoredWindow) {
    const arr = byDate.get(r.news_date) ?? [];
    arr.push(r);
    byDate.set(r.news_date, arr);
  }

  const perDay: Array<{ date: string; score: number; contributors: number }> = [];
  for (let i = 0; i < 8; i++) {
    const date = addDaysISO(asOfISO, -i);
    const items = byDate.get(date);
    if (!items || items.length === 0) continue;
    const enriched = items.map((r) => ({
      headline: r.headline,
      source: r.source,
      sentiment: r.sentiment,
      entities: r.entities,
      source_weight: r.source_weight,
      date: r.news_date,
    }));
    const agg = aggregatedSentimentForSymbol(symbol, name, enriched, date);
    if (agg.contributors > 0) perDay.push({ date, score: agg.score, contributors: agg.contributors });
  }

  if (perDay.length === 0) {
    return {
      today: null, avg_3d: null, avg_7d: null,
      delta_3d: null, delta_7d: null, accel: null, contributors_7d: 0,
    };
  }

  const today = perDay.find((d) => d.date === asOfISO)?.score ?? null;
  const last3 = perDay.filter((d) => d.date >= addDaysISO(asOfISO, -2)).map((d) => d.score);
  const last7 = perDay.filter((d) => d.date >= addDaysISO(asOfISO, -6)).map((d) => d.score);
  const avg3 = mean(last3);
  const avg7 = mean(last7);
  const delta3 = today != null && avg7 != null ? Number((today - avg7).toFixed(3)) : null;
  const delta7 = avg3 != null && avg7 != null ? Number((avg3 - avg7).toFixed(3)) : null;
  const accel = delta3 != null && delta7 != null ? Number((delta3 - delta7).toFixed(3)) : null;
  const contributors_7d = perDay.reduce((s, d) => s + d.contributors, 0);

  return {
    today: today == null ? null : Number(today.toFixed(3)),
    avg_3d: avg3 == null ? null : Number(avg3.toFixed(3)),
    avg_7d: avg7 == null ? null : Number(avg7.toFixed(3)),
    delta_3d: delta3,
    delta_7d: delta7,
    accel,
    contributors_7d,
  };
}
