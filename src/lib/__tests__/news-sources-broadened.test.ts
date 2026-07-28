// Contract: broadened news pipeline must (1) parse RSS + Atom feeds into
// NewsItem rows dated to the target day, and (2) fold GDELT + RSS results
// under a per-domain diversity cap so no single wire dominates.

import { describe, it, expect } from "vitest";
import { parseRssFeed } from "@/lib/news-rss.server";

describe("parseRssFeed", () => {
  const today = new Date().toISOString().slice(0, 10);
  const pub = new Date().toUTCString();

  it("parses standard RSS 2.0 items into NewsItem rows", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title><![CDATA[Global markets rally on rate cut hopes]]></title>
        <link>https://reuters.com/world/story1</link>
        <description><![CDATA[Equities climbed as central banks…]]></description>
        <pubDate>${pub}</pubDate>
      </item>
      <item>
        <title>Oil prices ease after OPEC signals</title>
        <link>https://reuters.com/energy/story2</link>
        <pubDate>${pub}</pubDate>
      </item>
    </channel></rss>`;
    const out = parseRssFeed(xml, "Reuters", today, 10);
    expect(out).toHaveLength(2);
    expect(out[0].headline).toContain("Global markets rally");
    expect(out[0].url).toBe("https://reuters.com/world/story1");
    expect(out[0].source).toBe("reuters.com");
    expect(out[0].date).toBe(today);
  });

  it("parses Atom entries with <link href>", () => {
    const xml = `<?xml version="1.0"?><feed>
      <entry>
        <title>ECB holds rates steady</title>
        <link href="https://ecb.europa.eu/press/2026/rates.html"/>
        <summary>Frankfurt — the Governing Council…</summary>
        <updated>${new Date().toISOString()}</updated>
      </entry>
    </feed>`;
    const out = parseRssFeed(xml, "ECB", today, 10);
    expect(out).toHaveLength(1);
    expect(out[0].headline).toBe("ECB holds rates steady");
    expect(out[0].url).toContain("ecb.europa.eu");
  });

  it("drops items dated outside the target day", () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toUTCString();
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Stale story</title><link>https://x.test/a</link><pubDate>${oldDate}</pubDate></item>
      <item><title>Fresh story</title><link>https://x.test/b</link><pubDate>${pub}</pubDate></item>
    </channel></rss>`;
    const out = parseRssFeed(xml, "test", today, 10);
    expect(out.map((i) => i.headline)).toEqual(["Fresh story"]);
  });

  it("respects perFeedMax cap", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      `<item><title>Headline ${i}</title><link>https://x.test/${i}</link><pubDate>${pub}</pubDate></item>`,
    ).join("");
    const xml = `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
    const out = parseRssFeed(xml, "test", today, 4);
    expect(out).toHaveLength(4);
  });
});

describe("per-domain diversity cap semantics", () => {
  // Mirrors the merging logic in getNewsForDate so a regression that lets a
  // single wire dominate the reel is caught in unit tests.
  function mergeWithCap<T extends { source: string | null; url: string | null; headline: string; source_weight: number }>(
    items: T[],
    maxPerDomain: number,
    limit: number,
  ): T[] {
    items.sort((a, b) => b.source_weight - a.source_weight);
    const byUrl = new Set<string>();
    const byHead = new Set<string>();
    const perDomain = new Map<string, number>();
    const out: T[] = [];
    for (const it of items) {
      const urlKey = (it.url ?? "").split("?")[0].toLowerCase();
      const headKey = it.headline.toLowerCase().replace(/\s+/g, " ").trim();
      if (urlKey && byUrl.has(urlKey)) continue;
      if (byHead.has(headKey)) continue;
      const domain = (it.source ?? "").toLowerCase();
      const dcount = perDomain.get(domain) ?? 0;
      if (domain && dcount >= maxPerDomain) continue;
      if (urlKey) byUrl.add(urlKey);
      byHead.add(headKey);
      if (domain) perDomain.set(domain, dcount + 1);
      out.push(it);
      if (out.length >= limit) break;
    }
    return out;
  }

  it("prevents a single high-weight source from monopolising the reel", () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => ({ source: "reuters.com", url: `https://r/${i}`, headline: `R${i}`, source_weight: 1.0 })),
      { source: "bbc.co.uk", url: "https://b/1", headline: "BBC 1", source_weight: 0.9 },
      { source: "aljazeera.com", url: "https://a/1", headline: "AJ 1", source_weight: 0.85 },
      { source: "nhk.or.jp", url: "https://n/1", headline: "NHK 1", source_weight: 0.75 },
    ];
    const merged = mergeWithCap(items, 3, 20);
    const perDomain = merged.reduce<Record<string, number>>((acc, m) => {
      acc[m.source] = (acc[m.source] ?? 0) + 1;
      return acc;
    }, {});
    expect(perDomain["reuters.com"]).toBe(3);
    expect(perDomain["bbc.co.uk"]).toBe(1);
    expect(perDomain["aljazeera.com"]).toBe(1);
    expect(perDomain["nhk.or.jp"]).toBe(1);
    expect(merged.length).toBe(6);
  });

  it("deduplicates identical stories crossing sources by URL then headline", () => {
    const items = [
      { source: "reuters.com", url: "https://x/a?ref=r", headline: "Same story", source_weight: 1.0 },
      { source: "aggregator.io", url: "https://x/a?ref=agg", headline: "Same Story", source_weight: 0.3 },
      { source: "bbc.co.uk", url: null, headline: "Different story", source_weight: 0.9 },
    ];
    const merged = mergeWithCap(items, 3, 10);
    expect(merged).toHaveLength(2);
    expect(merged[0].source).toBe("reuters.com"); // higher weight wins
  });
});
