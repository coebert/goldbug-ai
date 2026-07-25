// Wallet & affordability preview: shows how portfolios.current_cash maps
// into cash_by_ccy, and — using the same trimmer the executor runs before
// placing orders — how per-currency balances constrain currently pending
// buys. Pure preview: no DB writes, no broker calls.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { readWallet } from "./portfolio-wallet";
import {
  trimBuysToBudgetByCurrency,
  type MultiCcyBudgetOrder,
} from "./pre-place-budget-multi-ccy";

export type WalletAffordabilityResult = Awaited<
  ReturnType<typeof getWalletAffordability>
>;

export const getWalletAffordability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: p, error } = await supabase
      .from("portfolios")
      .select(
        "id, currency, current_cash, cash_by_ccy, fx_enabled, fx_execution_mode",
      )
      .eq("id", data.portfolioId)
      .single();
    if (error || !p) throw new Error(error?.message ?? "Portfolio not found");

    const baseCcy = String(p.currency ?? "GBP").toUpperCase();
    const rawCashByCcy =
      p.cash_by_ccy && typeof p.cash_by_ccy === "object" && !Array.isArray(p.cash_by_ccy)
        ? (p.cash_by_ccy as Record<string, number>)
        : null;

    const wallet = readWallet({
      currency: p.currency,
      current_cash: p.current_cash,
      cash_by_ccy: rawCashByCcy,
    });

    // Currently open buy slices constrain the affordability preview.
    const { data: slices } = await supabase
      .from("pending_slices")
      .select("id, symbol, side, remaining_qty, limit_price, instrument_ccy, status")
      .eq("portfolio_id", data.portfolioId)
      .eq("side", "buy")
      .in("status", ["queued", "active", "open", "pending"]);

    const rows = (slices ?? []).filter(
      (s) => Number(s.remaining_qty) > 0,
    );

    // Fill in missing prices from price_cache (most recent close per symbol).
    const missing = Array.from(
      new Set(rows.filter((r) => !r.limit_price).map((r) => r.symbol)),
    );
    const priceMap = new Map<string, number>();
    if (missing.length > 0) {
      const { data: pc } = await supabase
        .from("price_cache")
        .select("symbol, close, price_date")
        .in("symbol", missing)
        .order("price_date", { ascending: false })
        .limit(missing.length * 8);
      for (const r of pc ?? []) {
        if (!priceMap.has(r.symbol)) priceMap.set(r.symbol, Number(r.close));
      }
    }

    const orders: MultiCcyBudgetOrder[] = rows.map((r) => ({
      symbol: r.symbol,
      side: "buy" as const,
      quantity: Number(r.remaining_qty),
      price: Number(r.limit_price ?? priceMap.get(r.symbol) ?? 0),
      instrument_ccy: (r.instrument_ccy || baseCcy).toUpperCase(),
    }));

    // Resolve one FX rate per non-base currency the pending buys touch.
    const neededCcys = Array.from(
      new Set(orders.map((o) => o.instrument_ccy).filter((c) => c !== baseCcy)),
    );
    const fxRates: Record<
      string,
      { rate: number; stale: boolean; source: string }
    > = {};
    if (neededCcys.length > 0) {
      const { getFxRate } = await import("./fx.server");
      await Promise.all(
        neededCcys.map(async (c) => {
          const r = await getFxRate(baseCcy, c);
          fxRates[c] = { rate: r.rate, stale: r.stale, source: r.source };
        }),
      );
    }
    const fx = (from: string, to: string): number | null => {
      if (from === to) return 1;
      if (from === baseCcy) return fxRates[to]?.rate ?? null;
      if (to === baseCcy) {
        const r = fxRates[from]?.rate;
        return r && r > 0 ? 1 / r : null;
      }
      return null;
    };
    const isRateStale = (from: string, to: string) =>
      Boolean(fxRates[to]?.stale || fxRates[from]?.stale);

    const trim = trimBuysToBudgetByCurrency(orders, wallet, baseCcy, fx, {
      allowFxConversion: p.fx_enabled === true,
      isRateStale,
    });

    // Requested-vs-allowed rollup per currency.
    const perCcy: Array<{
      ccy: string;
      balance: number;
      requested: number;
      allowed: number;
      shortfall: number;
    }> = Array.from(
      new Set([
        ...Object.keys(wallet),
        ...Object.keys(trim.totalRequestedByCcy),
        ...Object.keys(trim.totalAllowedByCcy),
      ]),
    ).map((ccy) => {
      const requested = trim.totalRequestedByCcy[ccy] ?? 0;
      const allowed = trim.totalAllowedByCcy[ccy] ?? 0;
      return {
        ccy,
        balance: wallet[ccy] ?? 0,
        requested,
        allowed,
        shortfall: Math.max(0, requested - allowed),
      };
    });

    return {
      baseCcy,
      currentCash: Number(p.current_cash ?? 0),
      rawCashByCcy,
      wallet,
      fxEnabled: p.fx_enabled === true,
      fxExecutionMode: p.fx_execution_mode ?? null,
      fxRates,
      perCcy,
      pendingBuys: orders,
      trim,
    };
  });
