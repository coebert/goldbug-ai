import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  runFxPlaybookBacktest,
  type FxBacktestResult,
} from "@/lib/fx-playbook-backtest";

export type FxPlaybookBacktestResponse = {
  years: number;
  costBps: number;
  side: "short" | "long";
  results: Array<FxBacktestResult & { error?: string }>;
};

/**
 * Replays the FX funding-leg playbook (−1.5% cut / +2.0% take / max hold)
 * over years of ECB daily closes so the rules can be judged on realised
 * hit rate and worst-case drawdown before they steer live cash.
 */
export const backtestFxPlaybook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        pairs: z.array(z.string().length(6)).min(1).max(8).default(["GBPUSD", "GBPEUR", "EURUSD"]),
        years: z.number().int().min(1).max(20).default(10),
        costBps: z.number().min(0).max(100).default(6),
        side: z.enum(["short", "long"]).default("short"),
        maxHoldDays: z.number().int().min(2).max(250).default(30),
      })
      .parse(i),
  )
  .handler(async ({ data }): Promise<FxPlaybookBacktestResponse> => {
    const { fetchFxHistory, daysAgo } = await import("@/lib/fx-history.server");
    const from = daysAgo(Math.round(data.years * 365));

    const results = await Promise.all(
      data.pairs.map(async (p) => {
        const pair = p.toUpperCase();
        const base = pair.slice(0, 3);
        const quote = pair.slice(3, 6);
        try {
          const bars = await fetchFxHistory(base, quote, from);
          return runFxPlaybookBacktest(pair, bars, {
            side: data.side,
            costBps: data.costBps,
            maxHoldDays: data.maxHoldDays,
          });
        } catch (e) {
          return {
            ...runFxPlaybookBacktest(pair, []),
            error: e instanceof Error ? e.message : "history unavailable",
          };
        }
      }),
    );

    return { years: data.years, costBps: data.costBps, side: data.side, results };
  });
