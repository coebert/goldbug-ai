// Single source of truth for "latest first" ordering of news-reel headlines.
// Both the server function (`getGlobalNewsReel`) and the client reel component
// use these helpers so the order can never drift between the two, including
// after a refresh replaces the underlying rows.

export type SortableNewsItem = {
  /** Precise ingestion timestamp (ISO) when known. */
  fetched_at?: string | null;
  /** Calendar date (YYYY-MM-DD) fallback. */
  date: string;
  /** Optional tie-breaker: number of AI decisions citing the headline. */
  decisions_count?: number;
};

/**
 * Epoch millis used for ordering. Prefers the precise ingestion timestamp and
 * falls back to midnight UTC of the news date. Unparseable values sort last.
 */
export function newsItemTimestamp(item: SortableNewsItem): number {
  const raw = item.fetched_at ? Date.parse(item.fetched_at) : NaN;
  if (Number.isFinite(raw)) return raw;
  const day = Date.parse(`${item.date}T00:00:00Z`);
  return Number.isFinite(day) ? day : 0;
}

/**
 * Newest first. Citation count is only a tie-breaker within the same instant —
 * it must never pull older headlines above newer ones.
 */
export function sortNewsLatestFirst<T extends SortableNewsItem>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      newsItemTimestamp(b) - newsItemTimestamp(a) ||
      (b.decisions_count ?? 0) - (a.decisions_count ?? 0),
  );
}

/** True when `items` is already in strict newest-first order. */
export function isSortedLatestFirst(items: readonly SortableNewsItem[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (newsItemTimestamp(items[i]) > newsItemTimestamp(items[i - 1])) return false;
  }
  return true;
}
