// Pure helpers for the historical news backfill.
//
// When the source catalogue grows (see `news-sources.ts`), the live reel only
// starts reflecting the new feeds from the next cron tick onwards — the
// preceding weeks stay sparse. The backfill re-ingests the last 30–90 days
// for the newly added publishers so the reel catches up immediately.
//
// Everything here is deterministic and dependency-free so it can be unit
// tested without network or database access.

export const MIN_BACKFILL_DAYS = 30;
export const MAX_BACKFILL_DAYS = 90;

/** Clamp a user-supplied lookback to the supported 30–90 day range. */
export function clampBackfillDays(input: unknown): number {
  const n = Math.round(Number(input));
  if (!Number.isFinite(n)) return MIN_BACKFILL_DAYS;
  return Math.min(MAX_BACKFILL_DAYS, Math.max(MIN_BACKFILL_DAYS, n));
}

/** `YYYY-MM-DD` for a Date, in UTC (news_cache.news_date is a UTC day). */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Shift an ISO day by whole days. */
export function addDaysISO(iso: string, days: number): string {
  return isoDay(new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000));
}

/** Whole days between two ISO days (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export type BackfillWindow = {
  /** Oldest day to ingest (inclusive). */
  start_date: string;
  /** Newest day to ingest (inclusive) — always yesterday, today is cron's job. */
  end_date: string;
  days_total: number;
};

/**
 * Build the ingest window. We stop at yesterday because the regular refresh
 * hook already owns today's rows and would fight the backfill over them.
 */
export function planBackfillWindow(todayISO: string, days: number): BackfillWindow {
  const total = clampBackfillDays(days);
  const end = addDaysISO(todayISO, -1);
  const start = addDaysISO(end, -(total - 1));
  return { start_date: start, end_date: end, days_total: total };
}

/**
 * Backfill walks newest → oldest so the most useful history lands first.
 * Returns the next day to process, or null when the window is exhausted.
 */
export function nextBackfillDate(cursorISO: string | null, startISO: string): string | null {
  if (!cursorISO) return null;
  return daysBetween(startISO, cursorISO) >= 0 ? cursorISO : null;
}

export type BackfillJobLike = {
  status: string;
  start_date: string;
  end_date: string;
  cursor_date: string | null;
  days_total: number;
  days_done: number;
  headlines_inserted: number;
};

/** 0–100 completion, plus how many days are still queued. */
export function backfillProgress(job: BackfillJobLike): { pct: number; remaining_days: number } {
  const total = Math.max(1, job.days_total);
  if (job.status === "completed") return { pct: 100, remaining_days: 0 };
  const remaining = job.cursor_date ? Math.max(0, daysBetween(job.start_date, job.cursor_date) + 1) : 0;
  const done = Math.min(total, Math.max(job.days_done, total - remaining));
  return { pct: Math.round((done / total) * 100), remaining_days: remaining };
}

/** Hostname without `www.`, or null when the URL is unusable. */
export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export type CatalogueSourceLike = { id: string; url: string; label?: string; weight?: number };

/**
 * Feed hostnames are not publisher domains: `feeds.bbci.co.uk` publishes as
 * `bbc.co.uk`, `rss.dw.com` as `dw.com`. The cache stores publisher domains
 * and GDELT indexes publisher domains, so every comparison and query must go
 * through this normalisation — otherwise every feed looks "new" and every
 * history query returns nothing.
 */
const PUBLISHER_OVERRIDES: Record<string, string> = {
  "feeds.bbci.co.uk": "bbc.co.uk",
  "feeds.a.dj.com": "wsj.com",
  "feeds.content.dowjones.io": "wsj.com",
  "feeds.skynews.com": "news.sky.com",
  "www3.nhk.or.jp": "nhk.or.jp",
  "feeds.marketwatch.com": "marketwatch.com",
};

/** Aggregators have no publisher history of their own — never backfill them. */
export const AGGREGATOR_DOMAINS = new Set(["news.google.com", "google.com", "bing.com"]);

const FEED_LABELS = new Set(["feeds", "feed", "rss", "rss2", "xml", "syndication", "www2", "www3", "api"]);

/** Publisher domain for a feed URL (null when unusable or an aggregator). */
export function publisherDomain(url: string | null | undefined): string | null {
  const host = hostFromUrl(url);
  if (!host) return null;
  if (PUBLISHER_OVERRIDES[host]) return PUBLISHER_OVERRIDES[host];
  if (AGGREGATOR_DOMAINS.has(host)) return null;
  const parts = host.split(".");
  while (parts.length > 2 && (FEED_LABELS.has(parts[0]) || parts[0].length === 1)) parts.shift();
  return parts.join(".");
}

/**
 * A catalogue feed counts as "newly added" when its publisher domain has
 * never appeared in the cache. That is the signal that the expanded source
 * list has no history behind it yet.
 */
export function newCatalogueSources<T extends CatalogueSourceLike>(
  sources: readonly T[],
  seenDomains: Iterable<string>,
): T[] {
  const seen = new Set<string>();
  for (const d of seenDomains) {
    const norm = (d ?? "").toLowerCase().replace(/^www\./, "").trim();
    if (!norm) continue;
    seen.add(norm);
    const pub = publisherDomain(`https://${norm}/`);
    if (pub) seen.add(pub);
  }
  const out: T[] = [];
  const taken = new Set<string>();
  for (const src of sources) {
    const host = publisherDomain(src.url);
    if (!host || seen.has(host) || taken.has(host)) continue;
    taken.add(host);
    out.push(src);
  }
  return out;
}


/** GDELT `seendate` (`20260701T120000Z`) → ISO day, or null when unparseable. */
export function seenDateToISODay(seendate: string | null | undefined): string | null {
  if (!seendate) return null;
  const m = String(seendate).match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) ? iso : null;
}

/**
 * Backfilled rows must NOT look freshly ingested — the reel sorts newest-first
 * by `fetched_at`, so stamping "now" would bury today's live headlines under
 * two months of history. We stamp midday UTC of the article's own day.
 */
export function backfillFetchedAt(dayISO: string): string {
  return new Date(Date.parse(`${dayISO}T00:00:00Z`) + 12 * 3_600_000).toISOString();
}

/** Human-readable one-liner for the UI. */
export function describeBackfillStatus(job: BackfillJobLike | null): string {
  if (!job) return "No backfill has run yet.";
  const { pct, remaining_days } = backfillProgress(job);
  switch (job.status) {
    case "completed":
      return `Backfill complete — ${job.headlines_inserted} historical headlines added from ${job.start_date} to ${job.end_date}.`;
    case "failed":
      return `Backfill stopped at ${pct}% (${job.headlines_inserted} added). Run it again to resume.`;
    case "cancelled":
      return `Backfill cancelled at ${pct}%.`;
    default:
      return `Backfilling ${job.start_date} → ${job.end_date}: ${pct}% done, ${remaining_days} day${remaining_days === 1 ? "" : "s"} left, ${job.headlines_inserted} headlines added.`;
  }
}
