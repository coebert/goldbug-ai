/**
 * Scheduled scan orchestration: run the post-reclaim scan on a cadence, store
 * the result, and serve cached matches so the UI never has to trigger a scan
 * by hand. Also owns the rate-limit backoff around the price provider.
 */

import type { ScanReport } from "@/lib/setup-scan.server";
import type { SetupMatch } from "@/lib/setup-scan";

/** Matches are only re-scanned when the newest stored run is older than this. */
export const SCAN_MAX_AGE_MINUTES = 60;

export type StoredScanRun = {
  id: string;
  ranAt: string;
  source: string;
  scanned: number;
  matches: SetupMatch[];
  nearMisses: { symbol: string; reason: string }[];
  errors: string[];
  durationMs: number;
  rateLimited: boolean;
  /** Minutes since the run finished. */
  ageMinutes: number;
  stale: boolean;
};

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /429|rate.?limit|too many requests/i.test(msg);
}

export function countRateLimitErrors(errors: string[]): number {
  return errors.filter((e) => isRateLimitError(e)).length;
}

function toStored(row: Record<string, unknown>): StoredScanRun {
  const ranAt = String(row["ran_at"]);
  const ageMinutes = Math.max(0, (Date.now() - new Date(ranAt).getTime()) / 60000);
  return {
    id: String(row["id"]),
    ranAt,
    source: String(row["source"] ?? "manual"),
    scanned: Number(row["scanned"] ?? 0),
    matches: (row["matches"] as SetupMatch[] | null) ?? [],
    nearMisses: (row["near_misses"] as { symbol: string; reason: string }[] | null) ?? [],
    errors: (row["errors"] as string[] | null) ?? [],
    durationMs: Number(row["duration_ms"] ?? 0),
    rateLimited: Boolean(row["rate_limited"]),
    ageMinutes,
    stale: ageMinutes > SCAN_MAX_AGE_MINUTES,
  };
}

/** Newest stored scan, or null when nothing has run yet. */
export async function readLatestScanRun(): Promise<StoredScanRun | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("setup_scan_runs")
    .select("id, ran_at, source, scanned, matches, near_misses, errors, duration_ms, rate_limited")
    .order("ran_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return toStored(data as unknown as Record<string, unknown>);
}

async function persistScanRun(
  report: ScanReport,
  source: string,
  durationMs: number,
): Promise<StoredScanRun | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const rateLimited = countRateLimitErrors(report.errors) > 0;
  const { data, error } = await supabaseAdmin
    .from("setup_scan_runs")
    .insert({
      source,
      scanned: report.scanned,
      matches: report.matches as unknown as never,
      near_misses: report.nearMisses.slice(0, 30) as unknown as never,
      errors: report.errors.slice(0, 20) as unknown as never,
      duration_ms: Math.round(durationMs),
      rate_limited: rateLimited,
    })
    .select("id, ran_at, source, scanned, matches, near_misses, errors, duration_ms, rate_limited")
    .single();
  if (error || !data) return null;

  // Keep the history small — the card only ever shows the newest run.
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  await supabaseAdmin.from("setup_scan_runs").delete().lt("ran_at", cutoff);

  return toStored(data as unknown as Record<string, unknown>);
}

/**
 * Return the cached scan when it is fresh enough, otherwise run a new one and
 * store it. When the provider rate-limits the fresh run badly, the previous
 * stored run is kept and served rather than overwriting good matches with a
 * half-empty scan.
 */
export async function getOrRefreshScan(opts: {
  source: string;
  force?: boolean;
  maxAgeMinutes?: number;
}): Promise<{ run: StoredScanRun | null; refreshed: boolean; note: string | null }> {
  const maxAge = opts.maxAgeMinutes ?? SCAN_MAX_AGE_MINUTES;
  const cached = await readLatestScanRun();
  if (!opts.force && cached && cached.ageMinutes <= maxAge) {
    return { run: cached, refreshed: false, note: null };
  }

  const { runReclaimScan } = await import("@/lib/setup-scan.server");
  const started = Date.now();
  let report: ScanReport;
  try {
    report = await runReclaimScan();
  } catch (err) {
    if (cached) {
      return {
        run: cached,
        refreshed: false,
        note: `Scan failed (${err instanceof Error ? err.message : String(err)}); showing the last good run.`,
      };
    }
    throw err;
  }

  const rateLimitErrors = countRateLimitErrors(report.errors);
  const heavilyRateLimited =
    rateLimitErrors > 0 && report.scanned < Math.max(5, rateLimitErrors * 2);
  if (heavilyRateLimited && cached) {
    return {
      run: cached,
      refreshed: false,
      note: `Price provider rate-limited the scan (${rateLimitErrors} symbols); keeping the previous run.`,
    };
  }

  const stored = await persistScanRun(report, opts.source, Date.now() - started);
  return {
    run: stored ?? cached,
    refreshed: stored != null,
    note:
      rateLimitErrors > 0
        ? `${rateLimitErrors} symbol${rateLimitErrors === 1 ? "" : "s"} were rate-limited and skipped this run.`
        : null,
  };
}
