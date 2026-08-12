import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SetupMatch } from "@/lib/setup-scan";

export type ReclaimScanResult = {
  scanned: number;
  matches: SetupMatch[];
  nearMisses: { symbol: string; reason: string }[];
  errors: string[];
};

/** Scan the candidate list for post-reclaim, high-vol, thin-tape setups. */
export const scanReclaimSetups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<ReclaimScanResult> => {
    const { runReclaimScan } = await import("@/lib/setup-scan.server");
    const report = await runReclaimScan();
    return {
      scanned: report.scanned,
      matches: report.matches,
      nearMisses: report.nearMisses.slice(0, 12),
      errors: report.errors.slice(0, 5),
    };
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
