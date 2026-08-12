import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SetupBacktestRun } from "@/lib/backtest/setup-scan-backtest.server";

export type SetupBacktestResult = Omit<SetupBacktestRun, "trades"> & {
  /** Trimmed sample of the most recent signals, newest first. */
  sampleTrades: SetupBacktestRun["trades"];
};

/** Backtest the post-reclaim rules across historical tickers. */
export const backtestReclaimSetups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z
      .object({
        limit: z.number().int().min(4).max(60).optional(),
        lookbackDays: z.number().int().min(400).max(3000).optional(),
        frictionBps: z.number().min(0).max(300).optional(),
        pullbackWindow: z.number().int().min(1).max(30).optional(),
      })
      .parse(v ?? {}),
  )
  .handler(async ({ data }): Promise<SetupBacktestResult> => {
    const { runSetupBacktestAcrossMarket } = await import(
      "@/lib/backtest/setup-scan-backtest.server"
    );
    const run = await runSetupBacktestAcrossMarket({
      limit: data.limit,
      lookbackDays: data.lookbackDays,
      config: {
        ...(data.frictionBps == null ? {} : { frictionBps: data.frictionBps }),
        ...(data.pullbackWindow == null ? {} : { pullbackWindow: data.pullbackWindow }),
      },
    });
    const { trades, ...rest } = run;
    // Keep the most recent signals, both policies, so the UI can pair each
    // match with its exact simulated outcome under either entry rule.
    const signalKeys = [...new Set(trades.map((t) => `${t.symbol}|${t.signalDate}`))]
      .sort((a, b) => b.split("|")[1].localeCompare(a.split("|")[1]))
      .slice(0, 25);
    const keep = new Set(signalKeys);
    return {
      ...rest,
      sampleTrades: trades
        .filter((t) => keep.has(`${t.symbol}|${t.signalDate}`))
        .sort((a, b) => b.signalDate.localeCompare(a.signalDate)),
    };
  });
