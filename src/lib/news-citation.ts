// Citation link generation for the news reel.
//
// Every headline in the reel must be verifiable. When the feed gave us a real
// article URL we link that; when it didn't (common for GDELT-sourced and
// translated rows) we fall back to a Google News search for the *original*
// headline text. That fallback URL is a contract: it has to survive
// code-switched titles (Latin + Cyrillic + CJK in one string) with correct
// percent-encoding, or the search resolves to nothing.
//
// Pure module — snapshot-locked in
// `src/lib/__tests__/news-citation-code-switched.snapshot.test.ts`.

/** Google News search endpoint used for headlines with no direct URL. */
export const NEWS_SEARCH_BASE = "https://www.google.com/search";

/**
 * Search URL for a headline. `encodeURIComponent` is deliberate: it
 * percent-encodes every non-ASCII code point as UTF-8 (so Cyrillic and CJK
 * round-trip exactly) while leaving Google's reserved `&`/`=` separators
 * untouched because they are encoded inside the query value.
 */
export function newsSearchUrl(headline: string): string {
  return `${NEWS_SEARCH_BASE}?q=${encodeURIComponent(String(headline ?? "").trim())}&tbm=nws`;
}

/**
 * The href a citation link should point at: the article when we have one,
 * otherwise the headline search fallback.
 */
export function citationHref(item: { url?: string | null; headline: string }): string {
  const url = typeof item.url === "string" ? item.url.trim() : "";
  return url.length > 0 ? url : newsSearchUrl(item.headline);
}

/** True when the citation is a fallback search rather than a real source. */
export function isFallbackCitation(item: { url?: string | null }): boolean {
  return !(typeof item.url === "string" && item.url.trim().length > 0);
}

/**
 * Recover the headline a fallback search URL was built from. Used by tests and
 * by diagnostics to prove the encoding round-trips.
 */
export function headlineFromSearchUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.href.startsWith(NEWS_SEARCH_BASE)) return null;
    return parsed.searchParams.get("q");
  } catch {
    return null;
  }
}
