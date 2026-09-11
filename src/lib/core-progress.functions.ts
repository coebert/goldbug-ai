/**
 * Server side of the Core Progress page: reads the owner's core-allocation
 * setting, the live value of the core holding, free cash and the recent core
 * buy fills, then hands them to the pure projection in `core-progress.ts`.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { computeCoreProgress, type CoreProgressResult } from "./core-progress";
import { cashReserveForNav } from "./next-best-trade";
import { governorForNav, minTicketBase } from "./cost-governor";
import { engineSymbolKey } from "./price-symbol";
import { normalizeMarketPriceForTrading } from "./market-price-units";
import { inferSaxoCurrency } from "./saxo-fees";

export type CoreProgressPanel = CoreProgressResult & {
  portfolioId: string;
  portfolioName: string;
  currency: string;
  coreSymbol: string;
  bandPct: number;
  navBase: number;
  cashBase: number;
  minTicketBase: number;
  coreQuantity: number;
  corePriceBase: number | null;
  recentBuys: Array<{ date: string; amountBase: number }>;
  asOf: string;
};

export const getCoreProgress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ portfolioId: z.string().uuid().optional() }).parse(i ?? {}),
  )
  .handler(async ({ data, context }): Promise<CoreProgressPanel> => {
    const db = context.supabase;

    const portfolio = await (async () => {
      if (data.portfolioId) {
        const { data: p, error } = await db
          .from("portfolios")
          .select("id, name, currency, current_cash")
          .eq("id", data.portfolioId)
          .single();
        if (error || !p) throw new Error(error?.message ?? "Portfolio not found");
        return p;
      }
      // The real-money book comes first: a paper/sim account must never be
      // what this page reports the core against.
      const { data: rows, error } = await db
        .from("portfolios")
        .select("id, name, currency, current_cash, mode, status, created_at")
        .in("mode", ["live_prod", "live_sim"])
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const all = rows ?? [];
      const active = all.filter((r) => String(r.status ?? "active") === "active");
      const pool = active.length > 0 ? active : all;
      const p = pool.find((r) => r.mode === "live_prod") ?? pool[0];
      if (!p) throw new Error("No live portfolio found");
      return p;
    })();

    const portfolioId = String(portfolio.id);
    const currency = String(portfolio.currency ?? "GBP").toUpperCase();
    const cashBase = Number(portfolio.current_cash ?? 0) || 0;
    const asOf = new Date().toISOString().slice(0, 10);

    const { loadCoreAllocationSettings } = await import("./trading-controls.server");
    const core = await loadCoreAllocationSettings();
    const coreKey = engineSymbolKey(core.symbol);

    const [holdingsRes, snapRes, fillsRes, costsRes] = await Promise.all([
      db.from("holdings").select("symbol, quantity").eq("portfolio_id", portfolioId),
      db
        .from("equity_snapshots")
        .select("total_value")
        .eq("portfolio_id", portfolioId)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("live_fills")
        .select("symbol, side, quantity, fill_price, filled_at")
        .eq("portfolio_id", portfolioId)
        .eq("side", "buy")
        .order("filled_at", { ascending: false })
        .limit(400),
      db.from("symbol_execution_costs").select("symbol_key, round_trip_bps, tickets, measured"),
    ]);
    if (holdingsRes.error) throw new Error(holdingsRes.error.message);

    const holdings = (holdingsRes.data ?? []).map((h) => ({
      symbol: String(h.symbol ?? ""),
      quantity: Number(h.quantity ?? 0) || 0,
    }));
    const coreQuantity = holdings
      .filter((h) => engineSymbolKey(h.symbol) === coreKey)
      .reduce((s, h) => s + h.quantity, 0);

    const { getPriceOn } = await import("./market-data.server");
    const { getFxRate } = await import("./fx.server");
    const rateToBase = async (from: string) => {
      const code = from.toUpperCase();
      if (code === currency) return 1;
      const r = await getFxRate(code, currency)
        .then((x) => Number(x.rate))
        .catch(() => NaN);
      return Number.isFinite(r) && r > 0 ? r : 1;
    };

    const rawPrice = await getPriceOn(core.symbol, asOf).catch(() => null);
    const corePriceLocal = rawPrice
      ? normalizeMarketPriceForTrading(core.symbol, Number(rawPrice))
      : null;
    const coreFx = await rateToBase(inferSaxoCurrency(core.symbol));
    const corePriceBase = corePriceLocal ? corePriceLocal * coreFx : null;
    const coreValueBase = corePriceBase ? coreQuantity * corePriceBase : 0;

    // NAV: latest snapshot, falling back to cash + the core value we can price.
    const navBase = Number(snapRes.data?.["total_value"] ?? 0) || cashBase + coreValueBase;

    const recentBuys = ((fillsRes.data ?? []) as Array<Record<string, unknown>>)
      .filter((f) => engineSymbolKey(String(f["symbol"] ?? "")) === coreKey)
      .map((f) => {
        const qty = Number(f["quantity"] ?? 0) || 0;
        const px = normalizeMarketPriceForTrading(
          String(f["symbol"] ?? ""),
          Number(f["fill_price"] ?? 0) || 0,
        );
        return {
          date: String(f["filled_at"] ?? "").slice(0, 10),
          amountBase: qty * px * coreFx,
        };
      })
      .filter((b) => b.date && b.amountBase > 0);

    const costRows = (costsRes.data ?? []) as Array<Record<string, unknown>>;
    const coreCost = costRows.find(
      (r) => String(r["symbol_key"] ?? "") === coreKey && r["measured"] === true,
    );
    const roundTripBps = Number(coreCost?.["round_trip_bps"]) || null;

    const gov = governorForNav(navBase || 10_000);
    const minTicket = minTicketBase({ navBase: navBase || 10_000, ...gov });

    const result = computeCoreProgress({
      navBase,
      coreValueBase,
      cashBase,
      cashReserveBase: cashReserveForNav(navBase),
      targetPct: core.targetPct,
      bandPct: core.bandPct,
      minTicketBase: minTicket,
      recentCoreBuys: recentBuys,
      roundTripBps,
      today: asOf,
    });

    return {
      ...result,
      portfolioId,
      portfolioName: String((portfolio as { name?: string }).name ?? "Portfolio"),
      currency,
      coreSymbol: core.symbol,
      bandPct: core.bandPct,
      navBase,
      cashBase,
      minTicketBase: minTicket,
      coreQuantity,
      corePriceBase,
      recentBuys: recentBuys.slice(0, 12),
      asOf,
    };
  });
