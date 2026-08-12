import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SetupMatch } from "@/lib/setup-scan";
import type { StoredScanRun } from "@/lib/setup-scan-schedule.server";

export type ReclaimScanResult = {
  scanned: number;
  matches: SetupMatch[];
  nearMisses: { symbol: string; reason: string }[];
  errors: string[];
};

export type ScheduledScanResult = ReclaimScanResult & {
  ranAt: string | null;
  source: string | null;
  ageMinutes: number | null;
  stale: boolean;
  rateLimited: boolean;
  note: string | null;
  refreshed: boolean;
};

function toResult(
  run: StoredScanRun | null,
  extras: { note: string | null; refreshed: boolean },
): ScheduledScanResult {
  return {
    scanned: run?.scanned ?? 0,
    matches: run?.matches ?? [],
    nearMisses: (run?.nearMisses ?? []).slice(0, 12),
    errors: (run?.errors ?? []).slice(0, 5),
    ranAt: run?.ranAt ?? null,
    source: run?.source ?? null,
    ageMinutes: run?.ageMinutes ?? null,
    stale: run?.stale ?? true,
    rateLimited: run?.rateLimited ?? false,
    note: extras.note,
    refreshed: extras.refreshed,
  };
}

/**
 * Serve the cached scan, refreshing it in-line only when it has aged past the
 * schedule window (the cron job normally keeps it warm).
 */
export const getScheduledScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({ refreshIfStale: z.boolean().optional() }).optional().parse(v) ?? {},
  )
  .handler(async ({ data }): Promise<ScheduledScanResult> => {
    const { getOrRefreshScan, readLatestScanRun } = await import(
      "@/lib/setup-scan-schedule.server"
    );
    if (data?.refreshIfStale === false) {
      const run = await readLatestScanRun();
      return toResult(run, { note: null, refreshed: false });
    }
    const { run, note, refreshed } = await getOrRefreshScan({ source: "auto" });
    return toResult(run, { note, refreshed });
  });

/** Force a fresh scan now (manual "Scan market" button). */
export const scanReclaimSetups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<ScheduledScanResult> => {
    const { getOrRefreshScan } = await import("@/lib/setup-scan-schedule.server");
    const { run, note, refreshed } = await getOrRefreshScan({ source: "manual", force: true });
    return toResult(run, { note, refreshed });
  });

/** Add scan matches to the caller's watchlist with the rule-derived levels. */
export const addSetupMatchesToWatchlist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({ symbols: z.array(z.string().trim().min(1).max(16)).min(1).max(20) }).parse(v),
  )
  .handler(async ({ data, context }): Promise<{ added: string[]; skipped: string[] }> => {
    const { evaluateSymbolSetup } = await import("@/lib/setup-scan.server");
    const added: string[] = [];
    const skipped: string[] = [];

    for (const raw of data.symbols) {
      const symbol = raw.toUpperCase();
      let match: SetupMatch | null = null;
      try {
        match = await evaluateSymbolSetup(symbol);
      } catch {
        match = null;
      }
      if (!match) {
        skipped.push(symbol);
        continue;
      }
      const { error } = await context.supabase.from("ticker_watches").upsert(
        {
          user_id: context.userId,
          symbol,
          label: match.name ?? "Post-reclaim setup",
          thesis: match.thesis,
          // Alert when it pulls back into the reclaimed averages and holds.
          buy_above: Number(match.zoneLow.toFixed(4)),
          oversold_rsi: 35,
          max_vol_pct: Math.round(match.annualVolPct * 1.2),
          drop_below: Number(match.invalidationBelow.toFixed(4)),
          active: true,
        },
        { onConflict: "user_id,symbol" },
      );
      if (error) skipped.push(symbol);
      else added.push(symbol);
    }

    return { added, skipped };
  });
