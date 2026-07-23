// LLM-scored news sentiment. Replaces keyword matching.
// - Uses gemini-3.1-flash-lite for cost.
// - Caches results directly on news_cache (sentiment, entities, source_weight).
// - Applies source weighting and exponential recency decay when aggregating.

import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
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
      i: z.number(),
      sentiment: z.number(), // -1..+1
      entities: z.array(z.string()), // tickers, companies, macro topics
    }),
  ),
});

async function scoreBatch(
  items: { i: number; headline: string; source: string | null }[],
): Promise<Map<number, { sentiment: number; entities: string[] }>> {
  const key = process.env.LOVABLE_API_KEY;
  const out = new Map<number, { sentiment: number; entities: string[] }>();
  if (!key || items.length === 0) return out;

  const gateway = createLovableAiGatewayProvider(key);
  const model = gateway("google/gemini-3.1-flash-lite");

  const prompt = `Score each financial news headline for market sentiment on -1 (very bearish) to +1 (very bullish), 0 = neutral. Extract entities as short uppercase strings (tickers or company/topic names). Reply strictly in the schema.

Headlines:
${items.map((it) => `${it.i}. [${it.source ?? "unknown"}] ${it.headline}`).join("\n")}`;

  try {
    const { output } = await generateText({
      model,
      prompt,
      output: Output.object({ schema: HeadlineScoreSchema }),
    });
    for (const s of output.scores) {
      const clamped = Math.max(-1, Math.min(1, Number(s.sentiment) || 0));
      const ents = Array.isArray(s.entities)
        ? s.entities.map((e) => String(e).toUpperCase().slice(0, 24)).slice(0, 8)
        : [];
      out.set(s.i, { sentiment: clamped, entities: ents });
    }
  } catch (err) {
    if (!NoObjectGeneratedError.isInstance(err)) {
      console.warn("sentiment: LLM scoring failed", err);
    }
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
        sentiment: e.sentiment as unknown as number,
        entities: e.entities,
        source_weight: e.source_weight as unknown as number,
      } as never)
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
