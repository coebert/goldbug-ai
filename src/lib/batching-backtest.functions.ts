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
import {
  MAX_REPLAY_SYMBOLS,
  DEFAULT_REPLAY_ADD_PCT,
  buildReplayBars,
  rankTradedSymbols,
} from "./backtest/batching-backtest.helpers";

export type OrderBatchingAbResponse = OrderBatchingAbResult & {
  symbols: string[];
  from: string;
  to: string;
  navBase: number;
  windowHours: number;
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
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<OrderBatchingAbResponse> => {
    const { data: pf } = await context.supabase
      .from("portfolios")
      .select("id, starting_cash, current_cash")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (!pf) throw new Error("Portfolio not found");

    // Symbols this portfolio actually trades: current holdings first, then
    // anything it has traded historically.
    const [{ data: holdRows }, { data: tradeRows }] = await Promise.all([
      context.supabase
        .from("holdings")
        .select("symbol, quantity")
        .eq("portfolio_id", data.portfolioId),
      context.supabase
        .from("trades")
        .select("symbol")
        .eq("portfolio_id", data.portfolioId)
        .order("trade_date", { ascending: false })
        .limit(400),
    ]);

    const symbols = rankTradedSymbols(
      (holdRows ?? []).map((r) => String(r.symbol)),
      (tradeRows ?? []).map((r) => String(r.symbol)),
      MAX_REPLAY_SYMBOLS,
    );
    if (symbols.length === 0) {
      throw new Error("No traded symbols yet — the replay needs some history to work with.");
    }

    const from = new Date(Date.now() - data.days * 86_400_000).toISOString().slice(0, 10);
    const { data: priceRows, error: priceErr } = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close")
      .in("symbol", symbols)
      .gte("price_date", from)
      .order("price_date", { ascending: true });
    if (priceErr) throw new Error(priceErr.message);

    const bars = buildReplayBars(
      (priceRows ?? []).map((r) => ({
        symbol: String(r.symbol),
        price_date: String(r.price_date),
        close: Number(r.close),
      })),
    );
    if (bars.length < 60) {
      throw new Error(
        `Not enough price history to replay (${bars.length} bars, need 60+). Let the price cache fill in first.`,
      );
    }

    const navBase = Math.max(
      1_000,
      Number(pf.starting_cash ?? 0) || Number(pf.current_cash ?? 0) || 10_000,
    );

    const { generateReplaySignals } = await import("./backtest/batching-replay-signals");
    const { runOrderBatchingAb } = await import("./backtest/order-batching-ab");
    const { minTicketBase, DEFAULT_GOVERNOR } = await import("./cost-governor");

    const signals = generateReplaySignals(bars, {
      navBase,
      addPctOfNav: DEFAULT_REPLAY_ADD_PCT,
      fastPeriod: 20,
      slowPeriod: 50,
      maxAddsPerName: 8,
    });

    const result = await runOrderBatchingAb({
      bars,
      signals,
      startingCash: navBase,
      minTicketBase: minTicketBase({
        navBase,
        minTicketPctOfNav: DEFAULT_GOVERNOR.minTicketPctOfNav,
        absoluteMinTicketBase: DEFAULT_GOVERNOR.absoluteMinTicketBase,
      }),
      windowHours: data.windowHours,
      maxPriceDriftPct: data.maxPriceDriftPct,
    });

    return {
      ...result,
      symbols,
      from: bars[0].date,
      to: bars[bars.length - 1].date,
      navBase,
      windowHours: data.windowHours,
    };
  });
