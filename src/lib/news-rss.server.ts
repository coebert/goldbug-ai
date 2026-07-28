// Minimal RSS/Atom fetcher used by the world-events reel. Kept intentionally
// dependency-free so it works inside the Cloudflare Worker runtime without
// bundling xml2js / fast-xml-parser.
//
// The extractor targets `<item>` (RSS 2.0), `<entry>` (Atom), and RDF's
// `<item>` (RSS 1.0). We accept `<title>`, `<link>`, `<description>` /
// `<summary>`, and `<pubDate>` / `<updated>` / `<dc:date>`, plus the common
// CDATA wrappers. Everything else is discarded.

import type { NewsItem } from "./news.server";
import { runWithBreaker } from "./_server/provider-circuit";
import { RSS_SOURCES } from "./news-sources";

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function extractTag(xml: string, tag: string): string | null {
  // Case-insensitive, allow namespaces (e.g. `<dc:date>`), tolerate CDATA.
  const re = new RegExp(
    `<(?:[a-z0-9]+:)?${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\\/(?:[a-z0-9]+:)?${tag}>`,
    "i",
  );
  const m = xml.match(re);
  return m ? m[1] : null;
}

function extractLink(itemXml: string): string | null {
  // Atom uses <link href="…"/>; RSS uses <link>…</link>.
  const atom = itemXml.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (atom) return atom[1];
  const rss = extractTag(itemXml, "link");
  return rss ? rss.trim() : null;
}

function ageHours(raw: string | null): number | null {
  if (!raw) return null;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 3_600_000;
}

function ageHours(raw: string | null): number | null {
  if (!raw) return null;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 3_600_000;
}

function domainFromUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function parseRssFeed(
  xml: string,
  fallbackSource: string,
  dateISO: string,
  perFeedMax: number,
): NewsItem[] {
  const out: NewsItem[] = [];
  // Match RSS <item>…</item> or Atom <entry>…</entry> (case-insensitive).
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) && out.length < perFeedMax) {
    const chunk = m[0];
    const rawTitle = extractTag(chunk, "title");
    if (!rawTitle) continue;
    const title = stripTags(rawTitle);
    if (!title) continue;
    const link = extractLink(chunk);
    const summaryRaw =
      extractTag(chunk, "description") ??
      extractTag(chunk, "summary") ??
      extractTag(chunk, "content");
    const summary = summaryRaw ? stripTags(summaryRaw).slice(0, 300) : null;
    const pub =
      extractTag(chunk, "pubDate") ??
      extractTag(chunk, "updated") ??
      extractTag(chunk, "date");
    // Accept items published within the last ~48h and stamp them against
    // the requested date. A strict `feedDate === dateISO` filter dropped
    // most items in low-activity hours or right after UTC midnight because
    // feeds still show yesterday's stories — leaving the reel empty.
    const hrs = ageHours(pub);
    if (hrs !== null && hrs > 48) continue;
    out.push({
      date: dateISO,
      source: domainFromUrl(link) ?? fallbackSource,
      headline: title,
      url: link,
      summary,
      original_headline: null,
      original_language: null,
      translation_confidence: null,
    });
  }
  return out;
}

/**
 * Fetch every configured RSS source in parallel and return a merged list.
 * Each feed is bounded (`perFeedMax`), timeouts are aggressive (~5s), and
 * failing feeds are silently skipped so the reel is only as slow as the
 * slowest surviving feed.
 */
export async function fetchRssForDate(
  dateISO: string,
  perFeedMax = 4,
): Promise<
  Array<NewsItem & { source_weight: number }>
> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; LovableTrader/1.0; +https://goldbug-ai.lovable.app)",
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  };

  const jobs = RSS_SOURCES.map(async (src) => {
    try {
      const res = await runWithBreaker(`rss:${src.id}`, () =>
        fetch(src.url, { headers, signal: AbortSignal.timeout(5_000) }).then(async (r) => {
          if (!r.ok && (r.status >= 500 || r.status === 429)) {
            try { await r.body?.cancel(); } catch { /* noop */ }
            throw new Error(`${src.id} transient ${r.status}`);
          }
          return r;
        }),
      );
      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* noop */ }
        return [] as Array<NewsItem & { source_weight: number }>;
      }
      const xml = await res.text();
      const items = parseRssFeed(xml, src.label, dateISO, perFeedMax);
      return items.map((it) => ({ ...it, source_weight: src.weight }));
    } catch {
      // Provider unavailable / breaker open / timeout — silently skip so
      // the surviving feeds still populate the reel.
      return [] as Array<NewsItem & { source_weight: number }>;
    }
  });

  const settled = await Promise.all(jobs);
  return settled.flat();
}
