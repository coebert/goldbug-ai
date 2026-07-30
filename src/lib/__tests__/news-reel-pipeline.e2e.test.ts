import { describe, it, expect, vi } from "vitest";

// The sentiment module reaches for the admin DB client and the AI gateway at
// module scope. This e2e exercises the deterministic pipeline only, so both are
// stubbed — no network, no database.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/ai-gateway.server", () => ({
  createLovableAiGatewayProvider: () => () => ({}),
}));

import { sortNewsLatestFirst, isSortedLatestFirst } from "@/lib/news-reel-sort";
import { dedupeNewsItems, dedupeKeysFor } from "@/lib/news-dedupe";
import { heuristicRelevance, blendRelevance, relevanceBandLabel } from "@/lib/news-relevance";
import type { RelevanceContext } from "@/lib/news-relevance";
import { citationHref, isFallbackCitation } from "@/lib/news-citation";
import { sourceWeight, aggregatedSentimentForSymbol } from "@/lib/sentiment.server";

/**
 * End-to-end pipeline test for the news reel.
 *
 * The reel's read path is: sort newest-first → collapse duplicates (including
 * Cyrillic↔Latin transliteration variants) → score relevance → attach
 * sentiment → build a citation link. Each stage already has unit tests; this
 * test wires the real functions together and asserts the *rendered row output*
 * is byte-identical no matter which script variants of the same story arrive,
 * and in what order.
 */

type PipelineInput = {
  headline: string;
  original_headline?: string | null;
  url?: string | null;
  source: string | null;
  date: string;
  fetched_at: string;
  sentiment: number | null;
  entities: string[];
};

type PipelineRow = {
  headline: string;
  relevance: number;
  band: string;
  tags: string[];
  citation: string;
  fallbackCitation: boolean;
  sourceWeight: number;
  sentiment: number;
};

const CTX: RelevanceContext = {
  symbols: ["GAZP", "ISF:xlon", "JNJ:xnys"],
  names: ["Gazprom", "Johnson & Johnson"],
  assetClasses: ["stock", "etf", "commodity"],
  currencies: ["GBP", "EUR", "USD"],
  riskLevel: "balanced",
};

const AS_OF = "2026-07-30";

/** The full reel pipeline, exactly as the read path composes it. */
function runPipeline(items: readonly PipelineInput[]): PipelineRow[] {
  // 1. Newest-first, so the survivor of any collapse is the freshest variant.
  const sorted = sortNewsLatestFirst(items);
  expect(isSortedLatestFirst(sorted)).toBe(true);

  // 2. Transliteration-aware collapse.
  const collapsed = dedupeNewsItems(sorted);

  // 3–5. Relevance, sentiment and citation for each surviving row.
  return collapsed.map((item) => {
    const weight = sourceWeight(item.source);
    const heuristic = heuristicRelevance(
      { headline: item.headline, source: item.source, source_weight: weight },
      CTX,
    );
    const scored = blendRelevance(heuristic, null);
    const sentiment = aggregatedSentimentForSymbol(
      "GAZP",
      "Gazprom",
      [
        {
          headline: item.headline,
          source: item.source,
          sentiment: item.sentiment,
          entities: item.entities,
          source_weight: weight,
          date: item.date,
        },
      ],
      AS_OF,
    );
    return {
      headline: item.headline,
      relevance: scored.score,
      band: relevanceBandLabel(scored.score),
      tags: scored.tags,
      citation: citationHref(item),
      fallbackCitation: isFallbackCitation(item),
      sourceWeight: weight,
      sentiment: Number(sentiment.score.toFixed(6)),
    };
  });
}

const BASE = {
  source: "reuters.com",
  date: "2026-07-30",
  sentiment: 0.42,
  entities: ["GAZP"],
} satisfies Omit<PipelineInput, "headline" | "fetched_at">;

/** The canonical (freshest) variant every arrival set must collapse onto. */
const CANONICAL: PipelineInput = {
  ...BASE,
  headline: "Gazprom uvelichil dobychu gaza na 12 protsentov",
  url: "https://www.reuters.com/markets/gazprom-output-2026?utm_source=rss",
  fetched_at: "2026-07-30T11:00:00Z",
};

/** Same story, Cyrillic original, filed earlier. */
const CYRILLIC: PipelineInput = {
  ...BASE,
  headline: "Газпром увеличил добычу газа на 12 процентов",
  original_headline: "Газпром увеличил добычу газа на 12 процентов",
  url: "https://www.reuters.com/markets/gazprom-output-2026",
  fetched_at: "2026-07-30T09:30:00Z",
};

/** Same story, alternative romanisation from another wire, earlier still. */
const ROMANIZED_ALT: PipelineInput = {
  ...BASE,
  headline: "Gazprom uvyelichil dobychu gaza na 12 protsyentov",
  url: null,
  fetched_at: "2026-07-30T08:15:00Z",
};

/** Same story again, code-switched Latin + Cyrillic in one title. */
const CODE_SWITCHED: PipelineInput = {
  ...BASE,
  headline: "Gazprom увеличил добычу gaza na 12 protsentov",
  original_headline: "Газпром увеличил добычу газа на 12 процентов",
  url: "https://www.reuters.com/markets/gazprom-output-2026/",
  fetched_at: "2026-07-30T07:00:00Z",
};

/** An unrelated story that must always survive alongside the collapsed row. */
const UNRELATED: PipelineInput = {
  headline: "Johnson & Johnson lifts full-year guidance",
  url: "https://www.ft.com/content/jnj-guidance-2026",
  source: "ft.com",
  date: "2026-07-30",
  fetched_at: "2026-07-30T06:00:00Z",
  sentiment: 0.2,
  entities: ["JNJ"],
};

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

describe("news reel pipeline (e2e)", () => {
  it("collapses every script variant of one story onto a single row", () => {
    const rows = runPipeline([CANONICAL, CYRILLIC, ROMANIZED_ALT, CODE_SWITCHED, UNRELATED]);
    expect(rows).toHaveLength(2);
    expect(rows[0].headline).toBe(CANONICAL.headline);
    expect(rows[1].headline).toBe(UNRELATED.headline);
  });

  it("produces identical collapsed output for every arrival order", () => {
    const expected = runPipeline([CANONICAL, CYRILLIC, ROMANIZED_ALT, CODE_SWITCHED, UNRELATED]);
    for (const order of permutations([CANONICAL, CYRILLIC, ROMANIZED_ALT, CODE_SWITCHED, UNRELATED])) {
      expect(runPipeline(order)).toEqual(expected);
    }
  });

  it("produces the same row whichever subset of variants arrives", () => {
    const full = runPipeline([CANONICAL, CYRILLIC, ROMANIZED_ALT, CODE_SWITCHED]);
    const subsets: PipelineInput[][] = [
      [CANONICAL, CYRILLIC],
      [CANONICAL, ROMANIZED_ALT],
      [CANONICAL, CODE_SWITCHED],
      [CANONICAL, CYRILLIC, CODE_SWITCHED],
      [CYRILLIC, CANONICAL, ROMANIZED_ALT],
    ];
    for (const subset of subsets) {
      expect(runPipeline(subset)).toEqual(full);
    }
  });

  it("keeps the survivor's citation link, never a fallback, when a URL exists", () => {
    const [row] = runPipeline([CYRILLIC, ROMANIZED_ALT, CANONICAL]);
    expect(row.fallbackCitation).toBe(false);
    expect(row.citation).toBe(citationHref(CANONICAL));
    expect(row.citation).toContain("reuters.com");
  });

  it("falls back to a search citation when only the URL-less variant survives", () => {
    const [row] = runPipeline([ROMANIZED_ALT]);
    expect(row.fallbackCitation).toBe(true);
    expect(row.citation).toContain("google.com/search");
  });

  it("scores relevance and sentiment identically across script variants", () => {
    // Relevance and sentiment are computed on the SURVIVOR, so every variant
    // set must yield one identical score pair — no drift between scripts.
    const results = [
      runPipeline([CANONICAL, CYRILLIC]),
      runPipeline([CODE_SWITCHED, CANONICAL]),
      runPipeline([ROMANIZED_ALT, CYRILLIC, CANONICAL]),
    ].map((rows) => ({
      relevance: rows[0].relevance,
      band: rows[0].band,
      sentiment: rows[0].sentiment,
      sourceWeight: rows[0].sourceWeight,
    }));
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0].relevance).toBeGreaterThan(0);
    expect(results[0].sourceWeight).toBe(1.0); // Reuters, tier-one wire
    expect(results[0].sentiment).toBeGreaterThan(0);
  });

  it("shares a transliteration dedupe key across all variants of the story", () => {
    const keysFor = (i: PipelineInput) => dedupeKeysFor(i).filter((k) => k.startsWith("t:"));
    const canonical = keysFor(CANONICAL);
    expect(canonical.length).toBeGreaterThan(0);
    for (const variant of [CYRILLIC, ROMANIZED_ALT, CODE_SWITCHED]) {
      expect(keysFor(variant).some((k) => canonical.includes(k))).toBe(true);
    }
  });

  it("never collapses a genuinely different story into the row", () => {
    const rows = runPipeline([CANONICAL, CYRILLIC, UNRELATED]);
    expect(rows.map((r) => r.headline)).toEqual([CANONICAL.headline, UNRELATED.headline]);
    expect(rows[1].citation).toContain("ft.com");
  });

  it("is idempotent when the same batch is processed twice", () => {
    const once = runPipeline([CANONICAL, CYRILLIC, ROMANIZED_ALT, UNRELATED]);
    const twice = runPipeline([
      CANONICAL, CYRILLIC, ROMANIZED_ALT, UNRELATED,
      CANONICAL, CYRILLIC, ROMANIZED_ALT, UNRELATED,
    ]);
    expect(twice).toEqual(once);
  });
});
