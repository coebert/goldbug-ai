// Unit + integration tests for headline language detection, translation
// pipeline, and cache reuse in src/lib/news.server.ts.
//
// The tests stub the AI SDK's generateText so nothing hits the network:
// each call returns a deterministic language/translation for the batch of
// numbered headlines it was asked to process. supabaseAdmin is stubbed to
// a minimal fluent builder that supports the exact chains news.server uses.
//
// What this file locks down:
//   - looksNonEnglish() ignores pure ASCII and routes anything with a
//     non-ASCII char through the LLM.
//   - translateHeadlines() keeps English rows untouched (no badge fields),
//     rewrites non-English rows with the English text + original metadata,
//     and gracefully degrades when the LLM returns no translation.
//   - Repeat calls for the same source headline are served from the
//     per-worker cache without a second LLM invocation.
//   - backfillTranslations() coalesces concurrent calls for the same date
//     into a single LLM batch and single DB pass.
//
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewsItem } from "../news.server";

type LlmCall = { prompt: string; count: number };
const llmCalls: LlmCall[] = [];

// Programmable stub: maps every incoming (i, headline) tuple to a language
// and translation. Anything not registered defaults to English/no-op.
const translations = new Map<string, { lang: string | null; translation: string | null; confidence?: number | null }>();

// news.server calls the Lovable AI gateway directly via fetch. Stub the
// global fetch so we never hit the network; parse the prompt to build a
// deterministic response from the `translations` map.
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("ai.gateway.lovable.dev")) {
      return originalFetch(input as RequestInfo, init);
    }
    const body = JSON.parse((init?.body as string) ?? "{}");
    const prompt: string = body.messages?.[0]?.content ?? "";
    const lines = prompt.split("\n").filter((l) => /^\d+\.\s/.test(l));
    llmCalls.push({ prompt, count: lines.length });
    const results = lines.map((l) => {
      const m = l.match(/^(\d+)\.\s(.+)$/);
      const i = Number(m?.[1] ?? 0);
      const text = (m?.[2] ?? "").trim();
      const t = translations.get(text) ?? { lang: "English", translation: null };
      return { i, lang: t.lang, translation: t.translation, confidence: t.confidence ?? null };
    });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});


// Track DB reads/writes so we can assert cache reuse and dedupe.
const dbReads: Array<{ table: string; filters: Record<string, unknown> }> = [];
const dbUpdates: Array<{ table: string; filters: Record<string, unknown>; patch: unknown }> = [];

type Row = { news_date: string; headline: string; original_language: string | null; original_headline: string | null };
const rows: Row[] = [];

function makeAdminMock() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let mode: "select" | "update" = "select";
      let patch: unknown = null;
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.update = (p: unknown) => { mode = "update"; patch = p; return chain; };
      chain.eq = (col: string, val: unknown) => { filters[col] = val; return chain; };
      chain.is = (col: string, val: unknown) => { filters[`${col}_is`] = val; return chain; };
      chain.in = (col: string, val: unknown) => { filters[`${col}_in`] = val; return chain; };
      chain.not = (col: string, _op: string, val: unknown) => { filters[`${col}_not`] = val; return chain; };
      chain.limit = () => chain;
      chain.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onFulfilled);
      function resolve() {
        if (mode === "update") {
          dbUpdates.push({ table, filters: { ...filters }, patch });
          const target = rows.find(
            (r) => r.news_date === filters.news_date && r.headline === filters.headline,
          );
          if (target && typeof patch === "object" && patch) {
            Object.assign(target, patch);
          }
          return { data: null, error: null };
        }
        dbReads.push({ table, filters: { ...filters } });
        if (table === "news_cache") {
          // Filter by common shapes news.server uses.
          let out = rows.slice();
          if (filters.news_date) out = out.filter((r) => r.news_date === filters.news_date);
          if (filters.original_language_is === null) out = out.filter((r) => r.original_language === null);
          if (Array.isArray(filters.original_headline_in)) {
            const set = new Set(filters.original_headline_in as string[]);
            out = out.filter((r) => r.original_headline && set.has(r.original_headline));
          }
          return { data: out, error: null };
        }
        return { data: [], error: null };
      }
      return chain;
    },
  };
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: makeAdminMock(),
}));

// news.server reads LOVABLE_API_KEY inside the LLM helper. Set it to a
// dummy value so the code path proceeds to our mocked generateText.
beforeEach(() => {
  process.env.LOVABLE_API_KEY = "test-key";
  llmCalls.length = 0;
  dbReads.length = 0;
  dbUpdates.length = 0;
  rows.length = 0;
  translations.clear();
  vi.resetModules(); // isolate the module-level translation cache between tests
});
afterEach(() => {
  vi.clearAllMocks();
});

function makeItem(headline: string, overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    date: "2025-07-23",
    source: "example.com",
    headline,
    url: null,
    summary: null,
    original_headline: null,
    original_language: null,
    translation_confidence: null,
    ...overrides,
  };
}


describe("looksNonEnglish", () => {
  it("returns false for pure ASCII English text", async () => {
    const { looksNonEnglish } = await import("../news.server");
    expect(looksNonEnglish("Federal Reserve holds interest rates steady")).toBe(false);
    expect(looksNonEnglish("Apple beats earnings, stock jumps 4%")).toBe(false);
  });

  it("returns true when any non-ASCII character is present", async () => {
    const { looksNonEnglish } = await import("../news.server");
    // Cyrillic
    expect(looksNonEnglish("Центробанк повысил ставку")).toBe(true);
    // Chinese
    expect(looksNonEnglish("央行加息")).toBe(true);
    // Accented Latin — still routed for detection
    expect(looksNonEnglish("Élysée annonce de nouvelles mesures")).toBe(true);
    // Emoji / symbol also triggers
    expect(looksNonEnglish("Markets rally 🚀")).toBe(true);
  });

  it("handles empty strings safely", async () => {
    const { looksNonEnglish } = await import("../news.server");
    expect(looksNonEnglish("")).toBe(false);
  });
});

describe("translateHeadlines", () => {
  it("leaves an English-only batch untouched and never hits the LLM", async () => {
    const { translateHeadlines } = await import("../news.server");
    const items = [makeItem("Fed holds rates"), makeItem("Oil dips on demand fears")];
    const out = await translateHeadlines(items);
    expect(out).toEqual(items);
    expect(llmCalls).toHaveLength(0);
  });

  it("rewrites non-English headlines and stores the original + language", async () => {
    translations.set("Центробанк повысил ставку", {
      lang: "Russian",
      translation: "Central bank raised the rate",
    });
    translations.set("央行加息", {
      lang: "Mandarin Chinese",
      translation: "Central bank raises rates",
    });
    const { translateHeadlines } = await import("../news.server");
    const out = await translateHeadlines([
      makeItem("Центробанк повысил ставку"),
      makeItem("Fed holds rates"), // English — should NOT be sent
      makeItem("央行加息"),
    ]);
    expect(out[0]).toMatchObject({
      headline: "Central bank raised the rate",
      original_headline: "Центробанк повысил ставку",
      original_language: "Russian",
    });
    expect(out[1]).toMatchObject({
      headline: "Fed holds rates",
      original_headline: null,
      original_language: null,
    });
    expect(out[2]).toMatchObject({
      headline: "Central bank raises rates",
      original_language: "Mandarin Chinese",
    });
    // Only the two non-English candidates were sent in the single batch.
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].count).toBe(2);
  });

  it("does not overwrite when the LLM classifies as English or omits a translation", async () => {
    // Accented Latin the model considers English (edge case).
    translations.set("Café closes early", { lang: "English", translation: null });
    // Missing translation string — treat as no-op.
    translations.set("Straße gesperrt", { lang: "German", translation: null });
    const { translateHeadlines } = await import("../news.server");
    const out = await translateHeadlines([
      makeItem("Café closes early"),
      makeItem("Straße gesperrt"),
    ]);
    expect(out[0].original_language).toBeNull();
    expect(out[0].headline).toBe("Café closes early");
    expect(out[1].original_language).toBeNull();
    expect(out[1].headline).toBe("Straße gesperrt");
  });

  it("serves repeat headlines from the in-memory cache on subsequent calls", async () => {
    translations.set("央行加息", { lang: "Mandarin Chinese", translation: "Central bank raises rates" });
    const { translateHeadlines } = await import("../news.server");
    await translateHeadlines([makeItem("央行加息")]);
    await translateHeadlines([makeItem("央行加息"), makeItem("央行加息")]);
    // First call did one LLM invocation; both later duplicates were cached.
    expect(llmCalls).toHaveLength(1);
  });

  it("deduplicates identical headlines inside a single batch", async () => {
    translations.set("Παγκόσμια αγορά", { lang: "Greek", translation: "Global market" });
    const { translateHeadlines } = await import("../news.server");
    await translateHeadlines([
      makeItem("Παγκόσμια αγορά"),
      makeItem("Παγκόσμια αγορά"),
      makeItem("Παγκόσμια αγορά"),
    ]);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].count).toBe(1); // three inputs collapsed to one
  });

  it("propagates the model-reported confidence score onto the translated item", async () => {
    translations.set("Столица под ударом", {
      lang: "Russian",
      translation: "Capital under attack",
      confidence: 0.91,
    });
    translations.set("Straße gesperrt", {
      lang: "German",
      translation: "Street closed",
      // No confidence supplied — should fall through as null on the item.
    });
    const { translateHeadlines } = await import("../news.server");
    const out = await translateHeadlines([
      makeItem("Столица под ударом"),
      makeItem("Straße gesperrt"),
    ]);
    expect(out[0]).toMatchObject({
      headline: "Capital under attack",
      original_language: "Russian",
      translation_confidence: 0.91,
    });
    expect(out[1]).toMatchObject({
      headline: "Street closed",
      original_language: "German",
      translation_confidence: null,
    });
  });

  it("clamps out-of-range confidence values into [0, 1]", async () => {
    translations.set("Παγκόσμια αγορά", { lang: "Greek", translation: "Global market", confidence: 1.7 });
    translations.set("央行加息", { lang: "Mandarin Chinese", translation: "Central bank raises rates", confidence: -0.5 });
    const { translateHeadlines } = await import("../news.server");
    const out = await translateHeadlines([
      makeItem("Παγκόσμια αγορά"),
      makeItem("央行加息"),
    ]);
    expect(out[0].translation_confidence).toBe(1);
    expect(out[1].translation_confidence).toBe(0);
  });
});


describe("backfillTranslations", () => {
  it("translates matching cached rows and writes back to news_cache", async () => {
    rows.push({
      news_date: "2025-07-23",
      headline: "Центробанк повысил ставку",
      original_language: null,
      original_headline: null,
    });
    rows.push({
      news_date: "2025-07-23",
      headline: "Fed holds rates", // English — heuristic filters this out
      original_language: null,
      original_headline: null,
    });
    translations.set("Центробанк повысил ставку", {
      lang: "Russian",
      translation: "Central bank raised the rate",
    });
    const { backfillTranslations } = await import("../news.server");
    const result = await backfillTranslations("2025-07-23");
    expect(result).toEqual({ scanned: 1, translated: 1 });
    expect(dbUpdates).toHaveLength(1);
    expect(dbUpdates[0].patch).toMatchObject({
      headline: "Central bank raised the rate",
      original_language: "Russian",
      original_headline: "Центробанк повысил ставку",
    });
  });

  it("coalesces concurrent calls for the same date into a single pass", async () => {
    rows.push({
      news_date: "2025-07-23",
      headline: "央行加息",
      original_language: null,
      original_headline: null,
    });
    translations.set("央行加息", { lang: "Mandarin Chinese", translation: "Central bank raises rates" });
    const { backfillTranslations } = await import("../news.server");
    const [a, b, c] = await Promise.all([
      backfillTranslations("2025-07-23"),
      backfillTranslations("2025-07-23"),
      backfillTranslations("2025-07-23"),
    ]);
    // All promises resolve to the same result.
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    // Only one LLM batch and one update — not three.
    expect(llmCalls).toHaveLength(1);
    expect(dbUpdates).toHaveLength(1);
  });
});
