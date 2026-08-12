// Historical backfill of the world-events reel.
//
// The live refresh hook only ever ingests *today*, so when the source
// catalogue is expanded the new publishers have no history behind them. This
// module re-ingests the last 30–90 days for those newly added feeds.
//
// Mechanics:
//   • RSS feeds only carry ~48h of items, so history comes from GDELT's
//     document API using a per-publisher `domainis:` query over the job's
//     date window. That returns the same publishers the new feeds cover.
//   • Work is chunked and resumable: a job row holds a cursor, and each
//     invocation (button press or cron tick) advances as far as its wall-clock
//     budget allows. Workers kill background promises, so everything is
//     awaited inline.
//   • Rows are stamped with `fetched_at` on the article's own day so the
//     newest-first reel ordering is not disturbed by two months of history.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runWithBreaker } from "./_server/provider-circuit";
import { RSS_SOURCES } from "./news-sources";
import { buildSeenKeySet, filterUnseen } from "./news-dedupe";
import {
  backfillFetchedAt,
  clampBackfillDays,
  daysBetween,
  addDaysISO,
  isoDay,
  newCatalogueSources,
  planBackfillWindow,
  publisherDomain,

  seenDateToISODay,
  type BackfillJobLike,
} from "./news-backfill";

export type NewsBackfillJob = BackfillJobLike & {
  id: string;
  requested_days: number;
  new_sources: Array<{ id: string; label: string; domain: string }>;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

const GDELT_TIMEOUT_MS = 15_000;
/**
 * GDELT documents "≤1 request / 5s", but in practice it answers a steady 5–8s
 * cadence with its plain-text throttle notice. 12s between publisher sweeps
 * is the first spacing that returns JSON reliably.
 */
const GDELT_PACE_MS = 12_000;
/** GDELT answers throttled callers with a plain-text notice — retry those. */
const GDELT_MAX_ATTEMPTS = 4;
const GDELT_RETRY_MS = 12_000;
const DEFAULT_BUDGET_MS = 45_000;

/** Publishers queried per invocation before the cursor moves on. */
const DOMAINS_PER_SLICE = 6;
const MAX_RECORDS = 120;


type GdeltArticle = { title?: string; url?: string; domain?: string; seendate?: string; language?: string };

function rowToJob(r: Record<string, unknown>): NewsBackfillJob {
  return {
    id: String(r.id),
    status: String(r.status),
    requested_days: Number(r.requested_days ?? 0),
    start_date: String(r.start_date),
    end_date: String(r.end_date),
    cursor_date: (r.cursor_date as string | null) ?? null,
    days_total: Number(r.days_total ?? 0),
    days_done: Number(r.days_done ?? 0),
    headlines_inserted: Number(r.headlines_inserted ?? 0),
    new_sources: Array.isArray(r.new_sources) ? (r.new_sources as NewsBackfillJob["new_sources"]) : [],
    last_error: (r.last_error as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    finished_at: (r.finished_at as string | null) ?? null,
  };
}

/** Publisher domains already represented in the cache. */
async function seenDomains(): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("news_cache")
    .select("source")
    .not("source", "is", null)
    .limit(5000);
  return Array.from(new Set((data ?? []).map((r) => String(r.source ?? "").toLowerCase()).filter(Boolean)));
}

/** Latest job for this user (or globally when called from cron). */
export async function latestBackfillJob(userId?: string | null): Promise<NewsBackfillJob | null> {
  let q = supabaseAdmin
    .from("news_backfill_jobs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);
  if (userId) q = q.eq("created_by", userId);
  const { data } = await q;
  return data && data[0] ? rowToJob(data[0] as Record<string, unknown>) : null;
}

/**
 * Create (or resume) a backfill job covering the last `days` days for every
 * catalogue feed whose publisher has no history in the cache yet.
 */
export async function startNewsBackfill(
  days: number,
  userId: string | null,
): Promise<{ job: NewsBackfillJob; resumed: boolean }> {
  const existing = await latestBackfillJob(userId);
  if (existing && existing.status === "running") return { job: existing, resumed: true };

  const requested = clampBackfillDays(days);
  const window = planBackfillWindow(isoDay(new Date()), requested);
  const fresh = newCatalogueSources(RSS_SOURCES, await seenDomains());
  const newSources = fresh.map((s) => ({
    id: s.id,
    label: s.label,
    domain: publisherDomain(s.url) ?? "",
  })).filter((s) => s.domain);


  const { data, error } = await supabaseAdmin
    .from("news_backfill_jobs")
    .insert({
      created_by: userId,
      status: "running",
      requested_days: requested,
      start_date: window.start_date,
      end_date: window.end_date,
      cursor_date: window.end_date,
      days_total: window.days_total,
      new_sources: newSources,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`Could not start backfill: ${error?.message ?? "unknown error"}`);
  return { job: rowToJob(data as Record<string, unknown>), resumed: false };
}

type DomainHistory = {
  articles: Array<{ day: string; headline: string; url: string | null; source: string }>;
  status: "ok" | "rate_limited" | "error";
};

/** One GDELT publisher-scoped query across the whole window, bucketed by day. */
async function fetchDomainHistory(domain: string, startISO: string, endISO: string): Promise<DomainHistory> {
  const start = `${startISO.replace(/-/g, "")}000000`;
  const end = `${endISO.replace(/-/g, "")}235959`;
  // `domain:` matches the publisher domain *and* its subdomains; `domainis:`
  // demands an exact host match, which never matches a feed hostname.
  const query = encodeURIComponent(`domain:${domain}`);
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&format=json` +
    `&maxrecords=${MAX_RECORDS}&sort=datedesc&startdatetime=${start}&enddatetime=${end}`;

  let lastStatus: DomainHistory["status"] = "error";
  for (let attempt = 0; attempt < GDELT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, GDELT_RETRY_MS * attempt));
    try {
      const res = await runWithBreaker(`gdelt:backfill:${domain}`, () =>
        fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; LovableTrader/1.0)" },
          signal: AbortSignal.timeout(GDELT_TIMEOUT_MS),
        }),
      );
      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* noop */ }
        lastStatus = res.status === 429 ? "rate_limited" : "error";
        continue;
      }
      const text = (await res.text()).trim();
      if (!text.startsWith("{") && !text.startsWith("[")) {
        // Plain-text body = GDELT's throttle sentinel. Back off and retry.
        lastStatus = "rate_limited";
        continue;
      }
      const json = JSON.parse(text) as { articles?: GdeltArticle[] };
      const out: Array<{ day: string; headline: string; url: string | null; source: string }> = [];
      for (const a of json.articles ?? []) {
        if (!a.title) continue;
        const day = seenDateToISODay(a.seendate);
        if (!day || daysBetween(startISO, day) < 0 || daysBetween(day, endISO) < 0) continue;
        out.push({ day, headline: a.title, url: a.url ?? null, source: (a.domain ?? domain).toLowerCase() });
      }
      return { articles: out, status: "ok" };
    } catch {
      lastStatus = "error";
    }
  }
  return { articles: [], status: lastStatus };
}


/** Existing headline/url keys across the whole window, for cross-day dedupe. */
async function windowSeenKeys(startISO: string, endISO: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from("news_cache")
    .select("headline, url, original_headline")
    .gte("news_date", startISO)
    .lte("news_date", endISO)
    .limit(5000);
  return buildSeenKeySet(
    (data ?? []).map((r) => ({
      headline: String(r.headline ?? ""),
      url: (r.url as string | null) ?? null,
      original_headline: (r as { original_headline?: string | null }).original_headline ?? null,
    })),
  );
}

export type BackfillAdvanceResult = {
  job: NewsBackfillJob | null;
  inserted: number;
  domains_processed: number;
  done: boolean;
  reason?: string;
};

/**
 * Advance the running job as far as the wall-clock budget allows. Safe to call
 * repeatedly and concurrently-ish: every insert is deduped against the cache,
 * so a replayed slice adds nothing.
 */
export async function advanceNewsBackfill(opts?: {
  userId?: string | null;
  budgetMs?: number;
}): Promise<BackfillAdvanceResult> {
  const budgetMs = Math.max(5_000, Math.min(120_000, opts?.budgetMs ?? DEFAULT_BUDGET_MS));
  const deadlineAt = Date.now() + budgetMs;

  const job = await latestBackfillJob(opts?.userId ?? null);
  if (!job) return { job: null, inserted: 0, domains_processed: 0, done: true, reason: "No backfill job." };
  if (job.status !== "running") {
    return { job, inserted: 0, domains_processed: 0, done: true, reason: `Job is ${job.status}.` };
  }

  // Older jobs stored *feed* hostnames (feeds.bbci.co.uk), which GDELT never
  // matches. Re-derive the publisher domain from the catalogue so in-flight
  // jobs heal themselves instead of sweeping 50 dead queries.
  const domains = job.new_sources
    .map((s) => {
      const src = RSS_SOURCES.find((c) => c.id === s.id);
      return publisherDomain(src?.url ?? `https://${s.domain}/`) ?? "";
    })
    .filter(Boolean);
  if (domains.length === 0) {
    const finished = await finishJob(job.id, "completed", null);
    return { job: finished, inserted: 0, domains_processed: 0, done: true, reason: "No newly added feeds to backfill." };
  }

  // A job that swept feeds under the old (broken) domains added nothing, so
  // rewind its pointer and re-sweep with the corrected publisher domains.
  const staleDomains =
    job.headlines_inserted === 0 &&
    job.days_done > 0 &&
    job.new_sources.some((s, i) => s.domain !== domains[i]);
  if (staleDomains) {
    await supabaseAdmin
      .from("news_backfill_jobs")
      .update({
        days_done: 0,
        cursor_date: job.end_date,
        new_sources: job.new_sources.map((s, i) => ({ ...s, domain: domains[i] })),
        last_error: null,
      })
      .eq("id", job.id);
    job.days_done = 0;
  }

  // The cursor doubles as a domain pointer: each slice takes the next batch of
  // publishers, and once every publisher has been swept the job completes.
  const startIdx = Math.min(job.days_done, domains.length);

  const seen = await windowSeenKeys(job.start_date, job.end_date);
  let inserted = 0;
  let processed = 0;
  let advanced = 0;
  let throttled = 0;

  try {
    for (let i = startIdx; i < domains.length; i++) {
      if (Date.now() > deadlineAt - GDELT_PACE_MS) break;
      if (processed > 0) await new Promise((r) => setTimeout(r, GDELT_PACE_MS));

      const history = await fetchDomainHistory(domains[i], job.start_date, job.end_date);
      processed++;

      // A throttled/failed sweep returns zero articles for a publisher that
      // almost certainly has history. Advancing the pointer here would retire
      // the feed unread — which is exactly how a job reached "36 of 36 feeds,
      // 0 headlines". Leave the pointer where it is and end the pass so the
      // next one retries this same feed after a cooling-off period.
      if (history.status !== "ok") {
        throttled++;
        await supabaseAdmin
          .from("news_backfill_jobs")
          .update({
            last_error:
              "GDELT is throttling history requests — the job will retry this feed on the next pass.",
          })
          .eq("id", job.id);
        break;
      }

      const weight = RSS_SOURCES.find((s) => s.id === job.new_sources[i]?.id)?.weight ?? 0.6;
      const candidates = history.articles.map((a) => ({
        date: a.day,
        source: a.source,
        headline: a.headline,
        url: a.url,
        summary: null as string | null,
        original_headline: null as string | null,
        original_language: null as string | null,
        translation_confidence: null as number | null,
      }));
      const unseen = filterUnseen(candidates, seen) as typeof candidates;
      if (unseen.length > 0) {
        const rows = unseen.map((n) => ({
          news_date: n.date,
          source: n.source,
          headline: n.headline,
          url: n.url,
          summary: n.summary,
          source_weight: weight,
          fetched_at: backfillFetchedAt(n.date),
        }));
        const { error } = await supabaseAdmin.from("news_cache").insert(rows);
        if (error) console.error("news-backfill: insert failed", error.message);
        else inserted += rows.length;
      }

      advanced = i + 1 - startIdx;
      await supabaseAdmin
        .from("news_backfill_jobs")
        .update({
          days_done: i + 1,
          headlines_inserted: job.headlines_inserted + inserted,
          last_error: null,
          cursor_date: addDaysISO(job.end_date, -Math.floor(((i + 1) / domains.length) * (job.days_total - 1))),
        })
        .eq("id", job.id);

      if (processed >= DOMAINS_PER_SLICE) break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await finishJob(job.id, "failed", message);
    return { job: failed, inserted, domains_processed: processed, done: true, reason: message };
  }

  const completed = startIdx + advanced >= domains.length;

  const final = completed
    ? await finishJob(job.id, "completed", null)
    : await latestBackfillJob(opts?.userId ?? null);

  const throttleNote =
    throttled > 0 ? ` ${throttled} feed${throttled === 1 ? " was" : "s were"} throttled by GDELT — run it again to retry.` : "";

  return {
    job: final,
    inserted,
    domains_processed: processed,
    done: completed,
    reason:
      (completed
        ? `Backfill complete across ${domains.length} newly added feed${domains.length === 1 ? "" : "s"}.`
        : `Swept ${processed} feed${processed === 1 ? "" : "s"} this pass, ${inserted} headline${inserted === 1 ? "" : "s"} added — more queued.`) +
      throttleNote,
  };

}

async function finishJob(id: string, status: string, error: string | null): Promise<NewsBackfillJob | null> {
  const patch: {
    status: string;
    last_error: string | null;
    finished_at: string;
    cursor_date?: string | null;
  } = {
    status,
    last_error: error,
    finished_at: new Date().toISOString(),
  };
  if (status === "completed") patch.cursor_date = null;
  const { data } = await supabaseAdmin
    .from("news_backfill_jobs")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  return data ? rowToJob(data as Record<string, unknown>) : null;
}

/** Stop a running job (user-initiated). */
export async function cancelNewsBackfill(userId: string | null): Promise<NewsBackfillJob | null> {
  const job = await latestBackfillJob(userId);
  if (!job || job.status !== "running") return job;
  return finishJob(job.id, "cancelled", null);
}

/** How many catalogue feeds currently have no history in the cache. */
export async function countNewCatalogueFeeds(): Promise<number> {
  return newCatalogueSources(RSS_SOURCES, await seenDomains()).length;
}
