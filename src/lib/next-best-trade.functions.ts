/**
 * Server side of the Portfolio page's "next best trade" panel.
 *
 * Gathers exactly what the live buy path uses — latest closes and indicators,
 * free cash, the governor's minimum ticket and position caps, this account's
 * measured round-trip cost, and the operator's cost hurdle — and hands them to
 * the pure ranker in `next-best-trade.ts`.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  rankNextBuys,
  cashReserveForNav,
  type NextBuyCandidate,
  type NextBuyRow,
} from "./next-best-trade";
import { DEFAULT_EDGE_SAFETY_MULTIPLE } from "./net-edge-gate";
import {
  governorForNav,
  minTicketBase,
  DEFAULT_MAX_POSITION_PCT_OF_NAV,
} from "./cost-governor";
import { DEFAULT_MAX_DIVERSIFIED_POSITION_PCT_OF_NAV, isDiversifiedFund } from "./diversified-fund";
import { engineSymbolKey } from "./price-symbol";
import { normalizeMarketPriceForTrading } from "./market-price-units";
import { inferSaxoCurrency } from "./saxo-fees";

export type NextBestTradePanel = {
  currency: string;
  navBase: number;
  cashBase: number;
  /** Cash held back for settlement and fees. */
  cashReserveBase: number;
  /** Cash actually available to deal with today. */
  deployableCashBase: number;
  minTicketBase: number;
  hurdleMultiple: number;
  measuredRoundTripBps: number | null;
  asOf: string;
  rows: NextBuyRow[];
};

export const getNextBestTrade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ portfolioId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }): Promise<NextBestTradePanel> => {
    const db = context.supabase;

    const [portfolioRes, holdingsRes, snapRes, controlsRes, symbolCostsRes] = await Promise.all([
      db
        .from("portfolios")
        .select("currency, current_cash, concentration_cap_pct")
        .eq("id", data.portfolioId)
        .single(),
      db.from("holdings").select("symbol, quantity").eq("portfolio_id", data.portfolioId),
      db
        .from("equity_snapshots")
        .select("total_value")
        .eq("portfolio_id", data.portfolioId)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from("trading_controls").select("cost_hurdle_multiple").eq("id", true).maybeSingle(),
      db.from("symbol_execution_costs").select("symbol_key, round_trip_bps, tickets, measured"),
    ]);

    if (portfolioRes.error || !portfolioRes.data) {
      throw new Error(portfolioRes.error?.message ?? "Portfolio not found");
    }
    if (holdingsRes.error) throw new Error(holdingsRes.error.message);

    const currency = String(portfolioRes.data.currency ?? "GBP").toUpperCase();
    const cashBase = Number(portfolioRes.data.current_cash ?? 0) || 0;

    const held = (holdingsRes.data ?? [])
      .map((h) => ({ symbol: String(h.symbol ?? ""), quantity: Number(h.quantity ?? 0) }))
      .filter((h) => h.symbol && h.quantity > 0);

    const hurdleMultiple =
      Number(
        (controlsRes.data as { cost_hurdle_multiple?: number | null } | null)
          ?.cost_hurdle_multiple,
      ) || DEFAULT_EDGE_SAFETY_MULTIPLE;

    // Account-wide measured round trip, ticket-weighted, plus each name's own.
    const costRows = (symbolCostsRes.data ?? []) as Array<Record<string, unknown>>;
    const measuredRows = costRows.filter((r) => (Number(r["tickets"]) || 0) > 0);
    const totalTickets = measuredRows.reduce((s, r) => s + (Number(r["tickets"]) || 0), 0);
    const accountRoundTripBps =
      totalTickets > 0
        ? measuredRows.reduce(
            (s, r) => s + (Number(r["round_trip_bps"]) || 0) * (Number(r["tickets"]) || 0),
            0,
          ) / totalTickets
        : null;
    const bySymbolCost = new Map<string, number>();
    for (const r of costRows) {
      const key = String(r["symbol_key"] ?? "");
      const bps = Number(r["round_trip_bps"]) || 0;
      if (key && r["measured"] === true && bps > 0) bySymbolCost.set(key, bps);
    }

    if (held.length === 0) {
      const navEmpty = Number(snapRes.data?.["total_value"] ?? cashBase) || cashBase;
      const govEmpty = governorForNav(navEmpty || 10_000);
      return {
        currency,
        navBase: navEmpty,
        cashBase,
        cashReserveBase: cashReserveForNav(navEmpty),
        deployableCashBase: Math.max(0, cashBase - cashReserveForNav(navEmpty)),
        minTicketBase: minTicketBase({ navBase: navEmpty || 10_000, ...govEmpty }),
        hurdleMultiple,
        measuredRoundTripBps: accountRoundTripBps,
        asOf: new Date().toISOString().slice(0, 10),
        rows: [],
      };
    }

    const { findSymbol } = await import("./universe.server");
    const { buildCandidateFeatures } = await import("./trading-engine/candidate-features.server");
    const { getFxRate } = await import("./fx.server");

    const universeSymbols = held.map((h) => {
      const base = engineSymbolKey(h.symbol).split(":")[0] ?? h.symbol;
      return (
        findSymbol(base) ?? { symbol: base, name: base, asset_class: "stock" as const }
      );
    });
    const asOf = new Date().toISOString().slice(0, 10);
    const features = await buildCandidateFeatures(universeSymbols as never, asOf);
    const featureBySymbol = new Map(
      features.map((f) => [String(f.symbol).toUpperCase(), f] as const),
    );

    const fxCache = new Map<string, number>();
    const rateToBase = async (from: string): Promise<number> => {
      const code = from.toUpperCase();
      if (code === currency) return 1;
      const cached = fxCache.get(code);
      if (cached != null) return cached;
      const rate = await getFxRate(code, currency)
        .then((r) => Number(r.rate))
        .catch(() => NaN);
      const safe = Number.isFinite(rate) && rate > 0 ? rate : 1;
      fxCache.set(code, safe);
      return safe;
    };

    const candidates: NextBuyCandidate[] = [];
    for (const h of held) {
      const base = engineSymbolKey(h.symbol).split(":")[0] ?? h.symbol;
      const feature = featureBySymbol.get(base.toUpperCase());
      if (!feature) continue;
      const price = normalizeMarketPriceForTrading(h.symbol, Number(feature.price ?? 0));
      if (!(price > 0)) continue;
      const tradeCurrency = inferSaxoCurrency(h.symbol);
      const fxToBase = await rateToBase(tradeCurrency);
      candidates.push({
        symbol: h.symbol,
        name: feature.name ?? base,
        assetClass: feature.asset_class ?? null,
        price,
        currency: tradeCurrency,
        fxToBase,
        atrPct: feature.atr_pct ?? null,
        rsi14: feature.rsi14 ?? null,
        change5d: feature.change5d ?? null,
        change30d: feature.change30d ?? null,
        macdHist: feature.macd_hist ?? null,
        sma20: normalizeMarketPriceForTrading(h.symbol, Number(feature.sma20 ?? 0)) || null,
        sma50: normalizeMarketPriceForTrading(h.symbol, Number(feature.sma50 ?? 0)) || null,
        sma200: normalizeMarketPriceForTrading(h.symbol, Number(feature.sma200 ?? 0)) || null,
        weeklyTrendUp: feature.weekly_trend_up ?? null,
        heldQuantity: h.quantity,
        heldValueBase: h.quantity * price * fxToBase,
        diversified: isDiversifiedFund({
          symbol: h.symbol,
          assetClass: feature.asset_class,
          name: feature.name,
        }),
        measuredRoundTripBps: bySymbolCost.get(engineSymbolKey(h.symbol)) ?? null,
      });
    }

    const holdingsValueBase = candidates.reduce((s, c) => s + c.heldValueBase, 0);
    const navBase =
      Number(snapRes.data?.["total_value"] ?? 0) || cashBase + holdingsValueBase;
    const gov = governorForNav(navBase || 10_000);
    const cashReserveBase = cashReserveForNav(navBase);
    const capPct = Number(portfolioRes.data.concentration_cap_pct);

    const rows = rankNextBuys({
      candidates,
      navBase,
      cashBase,
      minTicketBase: minTicketBase({ navBase: navBase || 10_000, ...gov }),
      maxPositionPctOfNav:
        Number.isFinite(capPct) && capPct > 0
          ? capPct > 1
            ? capPct / 100
            : capPct
          : gov.maxPositionPctOfNav ?? DEFAULT_MAX_POSITION_PCT_OF_NAV,
      maxDiversifiedPositionPctOfNav: DEFAULT_MAX_DIVERSIFIED_POSITION_PCT_OF_NAV,
      safetyMultiple: hurdleMultiple,
      measuredRoundTripBps: accountRoundTripBps,
      cashReserveBase,
    });

    // Log today's shortlist so the history panel can later say what the
    // suggestion was actually worth. One row per symbol per London day, so
    // reopening the page re-states the latest read instead of duplicating it.
    const logged = rows.slice(0, 3);
    if (logged.length > 0) {
      const suggestedOn = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
      const { error: logError } = await db.from("next_best_trade_suggestions").upsert(
        logged.map((r, i) => ({
          portfolio_id: data.portfolioId,
          suggested_on: suggestedOn,
          suggested_at: new Date().toISOString(),
          symbol: r.symbol,
          name: r.name,
          currency: r.currency,
          rank: i + 1,
          conviction: r.conviction,
          price: r.price,
          quantity: r.quantity,
          ticket_base: r.ticketBase,
          cost_base: r.costBase,
          expected_profit_base: r.expectedProfitBase,
          expected_move_bps: r.expectedMoveBps,
          round_trip_bps: r.roundTripBps,
          net_edge_bps: r.netEdgeBps,
          recommended: r.recommended,
          blocked_reason: r.blockedReason,
        })),
        { onConflict: "portfolio_id,symbol,suggested_on" },
      );
      // A logging failure must never cost the user their suggestion.
      if (logError) console.warn("next-best-trade log failed:", logError.message);
    }

    return {
      currency,
      navBase,
      cashBase,
      cashReserveBase,
      deployableCashBase: Math.max(0, cashBase - cashReserveBase),
      minTicketBase: minTicketBase({ navBase: navBase || 10_000, ...gov }),
      hurdleMultiple,
      measuredRoundTripBps: accountRoundTripBps,
      asOf,
      rows,
    };
  });
