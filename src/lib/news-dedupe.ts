// Headline de-duplication shared by the ingestion path (cron + manual refresh)
// and the reel read path. GDELT/RSS re-publish the same story across days and
// across sources, so without this the reel shows visible repeats.

/** Canonical URL key: origin+path, lowercased, tracking params and trailing slash removed. */
export function canonicalUrlKey(url: string | null | undefined): string {
  if (!url) return "";
  const raw = url.trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return raw.split("?")[0].replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Normalised headline key: lowercase, accent-stripped, punctuation-collapsed.
 * Catches "Fed holds rates steady" vs "Fed holds rates steady." vs
 * "FED HOLDS RATES STEADY" — and common wire prefixes like "UPDATE 2-".
 *
 * Non-Latin scripts are preserved (letters/digits of ANY script survive), so
 * Chinese/Arabic/Cyrillic originals still produce a usable key instead of
 * collapsing to the empty string and slipping past headline-level dedupe.
 */
export function normalizeHeadlineKey(headline: string | null | undefined): string {
  if (!headline) return "";
  return headline
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^\s*(update|exclusive|breaking|analysis|refile|corrected|wrapup|factbox)\s*\d*\s*[-:–—]\s*/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export type DedupableNewsItem = {
  headline: string;
  url?: string | null;
  original_headline?: string | null;
};

/**
 * Every key a row should occupy, so later duplicates are recognised.
 *
 * Language-aware: a translated row occupies BOTH its English key and the key
 * of its original-language headline, so the same story arriving later in its
 * source language (or before/after a translation backfill) still collapses.
 */
export function dedupeKeysFor(item: DedupableNewsItem): string[] {
  const keys: string[] = [];
  const u = canonicalUrlKey(item.url);
  if (u) keys.push(`u:${u}`);
  const h = normalizeHeadlineKey(item.headline);
  if (h) keys.push(`h:${h}`);
  const o = normalizeHeadlineKey(item.original_headline);
  if (o && o !== h) keys.push(`h:${o}`);
  return keys;
}


/**
 * Keep the FIRST occurrence of each story. Callers that want "newest wins"
 * should sort newest-first before calling (the reel does).
 * Pure — the input array is not mutated.
 */
export function dedupeNewsItems<T extends DedupableNewsItem>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const keys = dedupeKeysFor(it);
    if (keys.length === 0) {
      out.push(it); // nothing identifiable — never silently drop it
      continue;
    }
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(it);
  }
  return out;
}

/** Build a seen-set from already-persisted rows, for ingestion-time filtering. */
export function buildSeenKeySet(existing: readonly DedupableNewsItem[]): Set<string> {
  const seen = new Set<string>();
  for (const e of existing) for (const k of dedupeKeysFor(e)) seen.add(k);
  return seen;
}

/** Filter incoming rows against an existing seen-set, mutating the set as it goes. */
export function filterUnseen<T extends DedupableNewsItem>(
  items: readonly T[],
  seen: Set<string>,
): T[] {
  const out: T[] = [];
  for (const it of items) {
    const keys = dedupeKeysFor(it);
    if (keys.length > 0 && keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(it);
  }
  return out;
}
