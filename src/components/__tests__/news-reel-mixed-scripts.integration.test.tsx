// Integration test: the news reel with mixed-script headlines.
//
// Renders the real <NewsReel/> (server-rendered markup, no jsdom) against a
// pre-seeded React Query cache containing Latin, CJK (zh/ja/ko) and Cyrillic
// (ru/uk) headlines, and asserts that mixing scripts does not destabilise:
//   1. ordering — strictly newest-first by `fetched_at`, identical to the
//      shared `sortNewsLatestFirst` helper the server uses;
//   2. badges — relevance band, sentiment and translation/detection labels
//      render for every row regardless of script;
//   3. citation links — each row links to its source URL, and rows without a
//      URL fall back to a correctly percent-encoded Google News search whose
//      query round-trips back to the original non-Latin headline.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { NewsReelItem } from "@/lib/news-reel.server";
import { sortNewsLatestFirst } from "@/lib/news-reel-sort";

// Server functions never run in this test: the query cache is pre-seeded.
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
  relevance_tags: ["theme:rates"],
  avg_sentiment: 0.25,
  decisions_count: 0,
  influences: [],
  note: "",
  excerpt: null,
  asset_classes: ["equity"],
  risk_levels: ["balanced"],
  symbols: [],
};

// Deliberately interleaved scripts and out-of-order timestamps.
const ITEMS: NewsReelItem[] = [
  {
    ...base,
    id: "latin-1",
    headline: "Bank of England holds rates at 4.25%",
    fetched_at: "2026-07-30T09:00:00Z",
    url: "https://example.com/boe-holds",
  },
  {
    ...base,
    id: "cjk-zh",
    headline: "China's central bank cuts the reserve requirement ratio",
    original_headline: "中国央行下调存款准备金率",
    original_language: "zh",
    translation_confidence: 0.94,
    fetched_at: "2026-07-30T11:30:00Z",
    url: "https://example.com/pboc-rrr",
    relevance_score: 88,
  },
  {
    ...base,
    id: "cyr-ru",
    headline: "Урожай пшеницы превысил прогноз",
    fetched_at: "2026-07-30T12:15:00Z",
    url: null, // forces the Google News citation fallback
    relevance_score: 45,
    avg_sentiment: -0.55,
    source: "Интерфакс",
  },
  {
    ...base,
    id: "cjk-ja",
    headline: "Yen slides as the BOJ keeps policy unchanged",
    original_headline: "日銀は政策を据え置き、円は下落",
    original_language: "ja",
    translation_confidence: 0.81,
    fetched_at: "2026-07-30T10:05:00Z",
    url: "https://example.com/boj",
  },
  {
    ...base,
    id: "cjk-ko",
    headline: "삼성전자 2분기 영업이익 급증",
    fetched_at: "2026-07-30T08:10:00Z",
    url: "https://example.com/samsung",
    source: "연합뉴스",
  },
  {
    ...base,
    id: "cyr-uk",
    headline: "Курс гривні стабілізувався після інтервенцій",
    fetched_at: "2026-07-30T13:45:00Z",
    url: "https://example.com/uah",
    relevance_score: 62,
    source: "Українські Новини",
  },
];

function render(items: NewsReelItem[]): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Default reel window: sinceDays=5, limit=40 (see NewsReel state defaults).
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

/** Positions of each headline in the rendered markup, in document order. */
function order(html: string, items: NewsReelItem[]): string[] {
  return items
    .map((it) => ({ id: it.id, at: html.indexOf(escapeHtml(it.headline)) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.id);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

let html = "";
beforeEach(() => {
  html = render(ITEMS);
});

describe("news reel with mixed Latin / CJK / Cyrillic headlines", () => {
  it("renders every headline, in its original script, once per layout variant", () => {
    // The reel emits a compact (mobile) and an expanded (desktop) variant of
    // each row, so every headline appears the same number of times — mixing
    // scripts must not drop or duplicate a row in one variant only.
    const counts = ITEMS.map((it) => html.split(escapeHtml(it.headline)).length - 1);
    for (const [i, n] of counts.entries()) {
      expect(n, `missing headline ${ITEMS[i].id}`).toBeGreaterThan(0);
    }
    expect(new Set(counts).size, `uneven render counts: ${counts.join(",")}`).toBe(1);
    // Non-Latin characters survive rendering un-mangled (no mojibake / escapes).
    expect(html).toContain("삼성전자");
    expect(html).toContain("Урожай пшеницы");
    expect(html).toContain("Курс гривні");
  });

  it("orders newest-first, matching the shared sort helper", () => {
    const expected = sortNewsLatestFirst(ITEMS).map((i) => i.id);
    expect(expected).toEqual(["cyr-uk", "cyr-ru", "cjk-zh", "cjk-ja", "latin-1", "cjk-ko"]);
    expect(order(html, ITEMS)).toEqual(expected);
  });

  it("keeps ordering stable when the same items arrive in a different order", () => {
    const shuffled = [...ITEMS].reverse();
    const again = render(shuffled);
    expect(order(again, ITEMS)).toEqual(order(html, ITEMS));
  });

  it("renders relevance and sentiment badges for non-Latin rows too", () => {
    // Relevance band labels are present for the scored rows across scripts.
    expect(html).toContain("88/100"); // zh
    expect(html).toContain("62/100"); // uk
    expect(html).toContain("45/100"); // ru
    // Sentiment badge on the Cyrillic row (negative → bearish).
    expect(html).toContain("bearish -0.55");
    // Non-Latin source names render in the source chips.
    expect(html).toContain("연합뉴스");
    expect(html).toContain(escapeHtml("Українські Новини"));
  });

  it("labels translated CJK rows with their detected language", () => {
    expect(html).toMatch(/Translated from[^<]*(Chinese|zh)/i);
    expect(html).toMatch(/Translated from[^<]*(Japanese|ja)/i);
    // Original-script headline is retained for audit.
    expect(html).toContain("中国央行下调存款准备金率");
    expect(html).toContain("日銀は政策を据え置き、円は下落");
  });

  it("links every row to a citation, percent-encoding non-Latin fallbacks", () => {
    for (const it of ITEMS) {
      if (it.url) {
        expect(html, `missing source link for ${it.id}`).toContain(`href="${it.url}"`);
      }
    }
    // The URL-less Cyrillic row falls back to a Google News search whose query
    // decodes back to the exact original headline.
    const fallback = `https://www.google.com/search?q=${encodeURIComponent("Урожай пшеницы превысил прогноз")}&amp;tbm=nws`;
    expect(html).toContain(fallback);
    const q = /google\.com\/search\?q=([^&"]+)&amp;tbm=nws/.exec(html)?.[1];
    expect(decodeURIComponent(q ?? "")).toBe("Урожай пшеницы превысил прогноз");
  });

  it("produces byte-identical markup across repeated renders", () => {
    expect(render(ITEMS)).toBe(html);
  });
});
