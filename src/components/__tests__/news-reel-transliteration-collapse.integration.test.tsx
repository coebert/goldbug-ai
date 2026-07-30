// Integration test: transliteration collapsing inside the rendered news reel.
//
// The same story reaches the reel twice — once in Cyrillic ("Газпром увеличил
// добычу газа") and once romanised by a different wire ("Gazprom uvelichil
// dobychu gaza"), sometimes with a competing romanisation ("Gazprom uvyelichil
// dobychu gaza"). `dedupeNewsItems` gives those rows a shared `t:` key, and
// <NewsReel/> dedupes AFTER sorting newest-first, so the newest variant must be
// the one that survives — carrying its own citation link and badges.
//
// This asserts the end-to-end rendered behaviour, not just the key function:
//   1. one row per story, with the losing variant's text absent from the DOM;
//   2. the surviving row keeps its own source URL (or a correctly encoded
//      fallback search when it has none);
//   3. relevance / sentiment / translation badges belong to the survivor, not
//      the dropped duplicate.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { NewsReelItem } from "@/lib/news-reel.server";
import { dedupeNewsItems } from "@/lib/news-dedupe";
import { sortNewsLatestFirst } from "@/lib/news-reel-sort";
import { transliterationKey } from "@/lib/news-transliterate";
import { normalizeHeadlineKey } from "@/lib/news-dedupe";
import { newsSearchUrl } from "@/lib/news-citation";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => async () => ({ items: [], as_of: new Date().toISOString(), has_more: false }),
}));
vi.mock("@/lib/trading.functions", () => ({
  getGlobalNewsReel: { __fn: "getGlobalNewsReel" },
  refreshGlobalNews: { __fn: "refreshGlobalNews" },
}));
vi.mock("@/lib/news-backfill.functions", () => ({
  getNewsBackfillStatus: { __fn: "status" },
  startNewsBackfillRun: { __fn: "start" },
  advanceNewsBackfillRun: { __fn: "advance" },
  cancelNewsBackfillRun: { __fn: "cancel" },
}));
vi.mock("@/lib/news-relevance-telemetry.functions", () => ({
  getRelevanceScoringTelemetry: { __fn: "telemetry" },
}));

const { NewsReel } = await import("@/components/news-reel");

const base: Omit<NewsReelItem, "id" | "headline" | "fetched_at" | "url"> = {
  date: "2026-07-30",
  source: "Reuters",
  original_headline: null,
  original_language: null,
  translation_confidence: null,
  relevance_score: 70,
  relevance_reason: "Touches a held name.",
  relevance_tags: ["theme:energy"],
  avg_sentiment: 0.2,
  decisions_count: 0,
  influences: [],
  note: "",
  excerpt: null,
  asset_classes: ["equity"],
  risk_levels: ["balanced"],
  symbols: [],
};

const CYRILLIC = "Газпром увеличил добычу газа на 12 процентов";
const ROMANISED = "Gazprom uvelichil dobychu gaza na 12 protsentov";
const ROMANISED_ALT = "Gazprom uvyelichil dobychu haza na 12 procentov";

/** Newest = the Cyrillic original, with its own URL and badges. */
const CYR_ROW: NewsReelItem = {
  ...base,
  id: "cyr-original",
  headline: CYRILLIC,
  fetched_at: "2026-07-30T12:00:00Z",
  url: "https://example.com/gazprom-ru",
  source: "Интерфакс",
  relevance_score: 84,
  avg_sentiment: -0.42,
};

/** Older romanised duplicate from an aggregator — must be dropped. */
const LAT_ROW: NewsReelItem = {
  ...base,
  id: "lat-romanised",
  headline: ROMANISED,
  fetched_at: "2026-07-30T09:30:00Z",
  url: "https://aggregator.example/gazprom-en",
  source: "Aggregator Wire",
  relevance_score: 31,
  avg_sentiment: 0.66,
};

/** A third, differently romanised copy — also collapses onto the same key. */
const LAT_ALT_ROW: NewsReelItem = {
  ...base,
  id: "lat-romanised-alt",
  headline: ROMANISED_ALT,
  fetched_at: "2026-07-30T08:00:00Z",
  url: "https://other.example/gazprom-alt",
  source: "Other Wire",
  relevance_score: 20,
};

/** Unrelated control row so we can prove dedupe is targeted, not global. */
const CONTROL_ROW: NewsReelItem = {
  ...base,
  id: "control",
  headline: "Bank of England holds rates at 4.25 percent",
  fetched_at: "2026-07-30T13:00:00Z",
  url: "https://example.com/boe",
  relevance_score: 55,
};

function render(items: NewsReelItem[]): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["global-news-reel", 5, 40], {
    items,
    as_of: "2026-07-30T14:00:00Z",
    has_more: false,
    since_days: 5,
    limit: 40,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <NewsReel />
    </QueryClientProvider>,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function occurrences(html: string, text: string): number {
  return html.split(escapeHtml(text)).length - 1;
}

let html = "";
beforeEach(() => {
  html = render([LAT_ROW, CYR_ROW, CONTROL_ROW, LAT_ALT_ROW]);
});

describe("transliteration variants share a dedupe key", () => {
  it("all three spellings fold to the same transliteration key", () => {
    const keys = [CYRILLIC, ROMANISED, ROMANISED_ALT].map((h) =>
      transliterationKey(h, normalizeHeadlineKey),
    );
    expect(keys[0]).not.toBe("");
    expect(new Set(keys).size).toBe(1);
  });

  it("dedupeNewsItems keeps exactly one of them (newest-first order)", () => {
    const kept = dedupeNewsItems(sortNewsLatestFirst([LAT_ROW, CYR_ROW, CONTROL_ROW, LAT_ALT_ROW]));
    expect(kept.map((k) => k.id)).toEqual(["control", "cyr-original"]);
  });
});

describe("news reel rendering with Cyrillic ↔ Latin variants", () => {
  it("renders one row for the story and drops the romanised duplicates", () => {
    const survivorCount = occurrences(html, CYRILLIC);
    expect(survivorCount).toBeGreaterThan(0);
    expect(occurrences(html, ROMANISED)).toBe(0);
    expect(occurrences(html, ROMANISED_ALT)).toBe(0);
    // Layout variants render the survivor the same number of times as an
    // untouched control row — dedupe must not clip one of the variants.
    expect(survivorCount).toBe(occurrences(html, CONTROL_ROW.headline));
  });

  it("keeps the unrelated control row", () => {
    expect(html).toContain(escapeHtml(CONTROL_ROW.headline));
  });

  it("preserves the surviving row's citation link and drops the duplicates'", () => {
    expect(html).toContain(`href="${CYR_ROW.url}"`);
    expect(html).not.toContain(LAT_ROW.url as string);
    expect(html).not.toContain(LAT_ALT_ROW.url as string);
  });

  it("falls back to an encoded search when the surviving row has no URL", () => {
    const noUrl = render([
      LAT_ROW,
      { ...CYR_ROW, url: null },
      CONTROL_ROW,
    ]);
    const expected = escapeHtml(newsSearchUrl(CYRILLIC));
    expect(noUrl).toContain(expected);
    expect(noUrl).not.toContain(LAT_ROW.url as string);
    const q = /google\.com\/search\?q=([^&"]+)&amp;tbm=nws/.exec(noUrl)?.[1];
    expect(decodeURIComponent(q ?? "")).toBe(CYRILLIC);
  });

  it("shows the survivor's badges, not the dropped duplicate's", () => {
    expect(html).toContain("84/100"); // Cyrillic row's relevance
    expect(html).not.toContain("31/100"); // romanised duplicate
    expect(html).not.toContain("20/100"); // alt romanisation
    expect(html).toContain("bearish -0.42"); // survivor's sentiment
    expect(html).not.toContain("0.66"); // duplicate's sentiment
    expect(html).toContain(escapeHtml("Интерфакс")); // survivor's source chip
    expect(html).not.toContain("Aggregator Wire");
    expect(html).not.toContain("Other Wire");
  });

  it("keeps the translation badge attached to the surviving row", () => {
    const translated = render([
      LAT_ROW,
      {
        ...CYR_ROW,
        headline: "Gazprom raised gas output by 12 percent",
        original_headline: CYRILLIC,
        original_language: "ru",
        translation_confidence: 0.91,
      },
      CONTROL_ROW,
    ]);
    expect(translated).toMatch(/Translated from[^<]*(Russian|ru)/i);
    expect(translated).toContain(escapeHtml(CYRILLIC)); // original kept for audit
    expect(translated).not.toContain(escapeHtml(ROMANISED));
  });

  it("collapses identically regardless of arrival order", () => {
    const orders: NewsReelItem[][] = [
      [LAT_ROW, CYR_ROW, CONTROL_ROW, LAT_ALT_ROW],
      [LAT_ALT_ROW, LAT_ROW, CONTROL_ROW, CYR_ROW],
      [CONTROL_ROW, CYR_ROW, LAT_ALT_ROW, LAT_ROW],
    ];
    const rendered = orders.map(render);
    for (const out of rendered) {
      expect(occurrences(out, CYRILLIC)).toBeGreaterThan(0);
      expect(occurrences(out, ROMANISED)).toBe(0);
      expect(occurrences(out, ROMANISED_ALT)).toBe(0);
      expect(out).toContain(`href="${CYR_ROW.url}"`);
    }
    expect(new Set(rendered).size).toBe(1);
  });
});
