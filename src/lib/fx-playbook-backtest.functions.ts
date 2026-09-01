import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  runFxPlaybookBacktest,
  sizeFxBacktest,
  type FxBacktestMoney,
  type FxBacktestResult,
} from "@/lib/fx-playbook-backtest";

export type FxPlaybookBacktestResponse = {
  years: number;
  costBps: number;
  side: "short" | "long";
  /** Cash the money columns are sized from, and where it came from. */
  capital: number;
  capitalSource: "portfolio_cash" | "starting_cash" | "override" | "none";
  currency: string;
  leverage: number;
  results: Array<FxBacktestResult & { error?: string; money: FxBacktestMoney }>;
};

/**
 * Replays the FX funding-leg playbook (−1.5% cut / +2.0% take / max hold)
 * over years of ECB daily closes, sized on the portfolio's real cash balance
 * and the chosen leverage so the hit rate, drawdown and tail are expressed in
 * the actual money at stake — not per-unit percentages.
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
        /** Size the replay on this portfolio's live cash balance. */
        portfolioId: z.string().uuid().optional(),
        /** Notional multiplier per leg (1 = unlevered cash). */
        leverage: z.number().min(0.1).max(10).default(1),
        /** Explicit capital, overriding the portfolio balance. */
        capitalOverride: z.number().positive().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<FxPlaybookBacktestResponse> => {
    const { fetchFxHistory, daysAgo } = await import("@/lib/fx-history.server");
    const from = daysAgo(Math.round(data.years * 365));

    let capital = 0;
    let capitalSource: FxPlaybookBacktestResponse["capitalSource"] = "none";
    let currency = "GBP";
    if (data.capitalOverride != null) {
      capital = data.capitalOverride;
      capitalSource = "override";
    }
    if (data.portfolioId) {
      const { data: p } = await context.supabase
        .from("portfolios")
        .select("current_cash, starting_cash, currency")
        .eq("id", data.portfolioId)
        .maybeSingle();
      currency = String(p?.currency ?? "GBP").toUpperCase();
      if (capitalSource !== "override") {
        const live = Number(p?.current_cash);
        if (Number.isFinite(live) && live > 0) {
          capital = live;
          capitalSource = "portfolio_cash";
        } else {
          const start = Number(p?.starting_cash);
          if (Number.isFinite(start) && start > 0) {
            capital = start;
            capitalSource = "starting_cash";
          }
        }
      }
    }

    const results = await Promise.all(
      data.pairs.map(async (p) => {
        const pair = p.toUpperCase();
        const base = pair.slice(0, 3);
        const quote = pair.slice(3, 6);
        let result: FxBacktestResult & { error?: string };
        try {
          const bars = await fetchFxHistory(base, quote, from);
          result = runFxPlaybookBacktest(pair, bars, {
            side: data.side,
            costBps: data.costBps,
            maxHoldDays: data.maxHoldDays,
          });
        } catch (e) {
          result = {
            ...runFxPlaybookBacktest(pair, []),
            error: e instanceof Error ? e.message : "history unavailable",
          };
        }
        return {
          ...result,
          // Cash is shared across the pairs in the run: each leg gets an equal
          // slice, so summing the per-pair money columns never implies more
          // capital than the portfolio actually has.
          money: sizeFxBacktest(result, { capital: perPairCapital, leverage: data.leverage }),
        };
      }),
    );

    return {
      years: data.years,
      costBps: data.costBps,
      side: data.side,
      capital,
      capitalSource,
      currency,
      leverage: data.leverage,
      results,
    };
  });
