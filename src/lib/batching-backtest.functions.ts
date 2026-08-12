// Server function backing the order-batching A/B backtest panel.
//
// Pulls this portfolio's traded universe out of `price_cache`, generates a
// deterministic momentum signal stream over that history, and replays it twice
// — batching on and batching off — so the operator can see, on their own data,
// whether the batching window actually reduces commission drag and whether it
// costs anything in drawdown.
//
// RLS-scoped via requireSupabaseAuth: the caller can only replay a portfolio
// they own. Read-only: nothing here writes to the ledger.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { OrderBatchingAbResult } from "./backtest/order-batching-ab";
import type { BenchmarkResult } from "./backtest/benchmark-arms";
import type {
  CostScenarioId,
  CostScenarioSweepResult,
} from "./backtest/cost-scenarios";
import {
  DEFAULT_REPLAY_ADD_PCT,
  loadReplayInputs,
} from "./backtest/batching-backtest.helpers";

export type CostScenarioResponse = CostScenarioSweepResult & {
  symbols: string[];
  from: string;
  to: string;
  navBase: number;
  windowHours: number;
};

export type OrderBatchingAbResponse = OrderBatchingAbResult & {
  symbols: string[];
  from: string;
  to: string;
  navBase: number;
  windowHours: number;
  /** Whether size-dependent market impact was charged. */
  marketImpact: boolean;
  /** Per-day buy-ticket cap actually applied (0 = uncapped). */
  maxTicketsPerDay: number;
  /** Buy-and-hold and momentum-only baselines over the same assets/period. */
  benchmarks: BenchmarkResult;
  /** Block-bootstrap distributions and 95% CIs for the A/B deltas. */
  confidence: AbConfidenceResult;
};


export const runOrderBatchingBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        days: z.number().int().min(60).max(750).default(365),
        /**
         * Batching window length. The live default is 24h, but on daily bars
         * a 24h window expires before the next signal can top it up, so the
         * replay defaults to a multi-day window and lets the operator sweep.
         */
        windowHours: z.number().int().min(6).max(336).default(96),
        maxPriceDriftPct: z.number().min(0.005).max(0.25).default(0.05),
        /** Charge size-dependent market impact + latency on every ticket. */
        marketImpact: z.boolean().default(true),
        urgency: z.enum(["passive", "normal", "aggressive"]).default("normal"),
        /** Cap on buy tickets routed per bar. 0 = uncapped. */
        maxTicketsPerDay: z.number().int().min(0).max(20).default(0),
        /** Override the NAV-scaled minimum ticket, base currency. 0 = default. */
        minTicketOverride: z.number().min(0).max(100000).default(0),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<OrderBatchingAbResponse> => {
    const { bars, symbols, navBase, advBySymbol } = await loadReplayInputs(context.supabase, {
      portfolioId: data.portfolioId,
      days: data.days,
    });

    const { generateReplaySignals } = await import("./backtest/batching-replay-signals");
    const { runOrderBatchingAb } = await import("./backtest/order-batching-ab");
    const { runBenchmarkArms } = await import("./backtest/benchmark-arms");
    const { minTicketBase, DEFAULT_GOVERNOR } = await import("./cost-governor");

    const signals = generateReplaySignals(bars, {
      navBase,
      addPctOfNav: DEFAULT_REPLAY_ADD_PCT,
      fastPeriod: 20,
      slowPeriod: 50,
      maxAddsPerName: 8,
    });

    const abInput = {
      bars,
      signals,
      startingCash: navBase,
      minTicketBase:
        data.minTicketOverride > 0
          ? data.minTicketOverride
          : minTicketBase({
              navBase,
              minTicketPctOfNav: DEFAULT_GOVERNOR.minTicketPctOfNav,
              absoluteMinTicketBase: DEFAULT_GOVERNOR.absoluteMinTicketBase,
            }),
      windowHours: data.windowHours,
      maxPriceDriftPct: data.maxPriceDriftPct,
      maxTicketsPerDay: data.maxTicketsPerDay > 0 ? data.maxTicketsPerDay : undefined,
      execution: {
        enabled: data.marketImpact,
        urgency: data.urgency,
        advBySymbol,
      },
    };

    const result = await runOrderBatchingAb(abInput);
    const { computeAbConfidence } = await import("./backtest/ab-confidence");
    const confidence = computeAbConfidence({
      batched: result.batched,
      unbatched: result.unbatched,
      startingValue: result.batched.startingValue,
    });
    const benchmarks = await runBenchmarkArms(abInput, {
      returnPct: result.batched.returnPct,
      maxDrawdownPct: result.batched.maxDrawdownPct,
      sharpe: result.batched.sharpe,
      costBpsOfEquity: result.batched.costBpsOfEquity,
    });

    return {
      ...result,
      benchmarks,
      symbols,
      from: bars[0].date,
      to: bars[bars.length - 1].date,
      navBase,
      windowHours: data.windowHours,
      marketImpact: data.marketImpact,
      maxTicketsPerDay: data.maxTicketsPerDay,
      confidence,
    };
  });

/**
 * Replay the strategy under best / base / worst fee, spread and stamp-duty
 * assumptions and report how often it avoided losses in each case.
 *
 * Read-only and RLS-scoped: the caller can only replay their own portfolio.
 */
export const runCostScenarioBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        days: z.number().int().min(60).max(750).default(365),
        windowHours: z.number().int().min(6).max(336).default(96),
        /** Length of the rolling loss-avoidance window, in trading days. */
        rollingWindowDays: z.number().int().min(5).max(120).default(21),
        scenarioIds: z
          .array(z.enum(["best", "base", "worst"]))
          .min(1)
          .max(3)
          .optional(),
        /** Price the live routing (batched) or the pre-batching behaviour. */
        arm: z.enum(["batched", "unbatched"]).default("batched"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<CostScenarioResponse> => {
    const { bars, symbols, navBase, advBySymbol } = await loadReplayInputs(context.supabase, {
      portfolioId: data.portfolioId,
      days: data.days,
    });

    const { generateReplaySignals } = await import("./backtest/batching-replay-signals");
    const { runCostScenarioSweep } = await import("./backtest/cost-scenarios");
    const { minTicketBase, DEFAULT_GOVERNOR } = await import("./cost-governor");

    const signals = generateReplaySignals(bars, {
      navBase,
      addPctOfNav: DEFAULT_REPLAY_ADD_PCT,
      fastPeriod: 20,
      slowPeriod: 50,
      maxAddsPerName: 8,
    });

    const result = await runCostScenarioSweep({
      bars,
      signals,
      startingCash: navBase,
      minTicketBase: minTicketBase({
        navBase,
        minTicketPctOfNav: DEFAULT_GOVERNOR.minTicketPctOfNav,
        absoluteMinTicketBase: DEFAULT_GOVERNOR.absoluteMinTicketBase,
      }),
      arm: data.arm,
      windowHours: data.windowHours,
      rollingWindowDays: data.rollingWindowDays,
      scenarioIds: data.scenarioIds as CostScenarioId[] | undefined,
      execution: { enabled: true, advBySymbol },
    });

    return {
      ...result,
      symbols,
      from: bars[0]!.date,
      to: bars[bars.length - 1]!.date,
      navBase,
      windowHours: data.windowHours,
    };
  });
