import { describe, it, expect } from "vitest";
import {
  NEWS_SEARCH_BASE,
  citationHref,
  headlineFromSearchUrl,
  isFallbackCitation,
  newsSearchUrl,
} from "../news-citation";

// Code-switched headlines mixing Latin with Cyrillic, CJK, Greek, Arabic and
// emoji — the shapes that historically broke percent-encoding.
const CODE_SWITCHED: Array<[name: string, headline: string]> = [
  ["latin+cyrillic", "Газпром cuts flows as Brent tops $95"],
  ["latin+cjk-japanese", "日銀 holds rates; yen slips vs USD"],
  ["latin+cjk-chinese", "中国央行 injects 500bn yuan into money markets"],
  ["latin+korean", "삼성전자 Q3 profit beats — chips rebound"],
  ["latin+greek", "Τράπεζα Ελλάδος warns on inflation (Q4)"],
  ["latin+arabic-rtl", "أرامكو raises OSP for Asia buyers"],
  ["reserved-chars", "S&P 500 +2.1% = record? yes/no #markets"],
  ["whitespace-heavy", "  ЕЦБ   holds\tfire  on  cuts \n"],
  ["emoji+mixed", "🚨 Ruble рубль slides 4% vs €"],
  ["plus-and-slash", "USD/JPY 150+ — 日本 intervention risk"],
];

describe("citation link snapshots — code-switched headlines", () => {
  it.each(CODE_SWITCHED)("fallback search URL is stable for %s", (_name, headline) => {
    expect(newsSearchUrl(headline)).toMatchSnapshot();
  });

  it("locks the full fallback URL table", () => {
    const table = Object.fromEntries(
      CODE_SWITCHED.map(([name, headline]) => [name, newsSearchUrl(headline)]),
    );
    expect(table).toMatchSnapshot();
  });

  it("pins the search endpoint and query shape", () => {
    expect(NEWS_SEARCH_BASE).toBe("https://www.google.com/search");
    expect(newsSearchUrl("Газпром cuts flows")).toBe(
      "https://www.google.com/search?q=%D0%93%D0%B0%D0%B7%D0%BF%D1%80%D0%BE%D0%BC%20cuts%20flows&tbm=nws",
    );
  });
});

describe("citation link encoding invariants", () => {
  it.each(CODE_SWITCHED)("round-trips the headline for %s", (_name, headline) => {
    expect(headlineFromSearchUrl(newsSearchUrl(headline))).toBe(headline.trim());
  });

  it.each(CODE_SWITCHED)("emits no raw non-ASCII or separators for %s", (_name, headline) => {
    const url = newsSearchUrl(headline);
    const query = url.slice(url.indexOf("?q=") + 3, url.indexOf("&tbm=nws"));
    expect(query).toMatch(/^[A-Za-z0-9%._~!*'()-]*$/);
    expect(url.match(/&/g) ?? []).toHaveLength(1);
    expect(url.endsWith("&tbm=nws")).toBe(true);
  });

  it("is idempotent across repeated generation", () => {
    for (const [, headline] of CODE_SWITCHED) {
      expect(newsSearchUrl(headline)).toBe(newsSearchUrl(headline));
    }
  });

  it("parses as a valid URL for every headline", () => {
    for (const [, headline] of CODE_SWITCHED) {
      expect(() => new URL(newsSearchUrl(headline))).not.toThrow();
    }
  });
});

describe("citationHref fallback selection", () => {
  it("prefers a real article URL", () => {
    const item = { url: "https://example.com/статья/1", headline: "Газпром cuts flows" };
    expect(citationHref(item)).toBe("https://example.com/статья/1");
    expect(isFallbackCitation(item)).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
  ])("falls back to search when url is %s", (_name, url) => {
    const item = { url: url as string | null | undefined, headline: "日銀 holds rates" };
    expect(citationHref(item)).toBe(newsSearchUrl("日銀 holds rates"));
    expect(isFallbackCitation(item)).toBe(true);
  });

  it("snapshots the mixed real/fallback citation map", () => {
    const items = [
      { url: "https://reuters.com/a", headline: "Γερμανία factory orders fall" },
      { url: null, headline: "中国央行 injects liquidity" },
      { url: "  ", headline: "Ruble рубль slides" },
    ];
    expect(items.map(citationHref)).toMatchSnapshot();
  });

  it("returns null when asked to decode a non-search URL", () => {
    expect(headlineFromSearchUrl("https://reuters.com/a")).toBeNull();
    expect(headlineFromSearchUrl("not a url")).toBeNull();
  });
});
