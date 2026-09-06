/**
 * Portfolio positions: each open symbol's size, cost basis and P&L, valued
 * off the broker's own tape first and this account's recorded fills for cost.
 *
 * Everything is returned twice where it matters: in the instrument's trading
 * currency (what the broker shows per line) and converted into the
 * portfolio's base currency (what the headline P&L is measured in). LSE
 * pence quotes are folded to GBP base units before any money math.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { engineSymbolKey, priceSymbolVariants } from "@/lib/price-symbol";
import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";

export type PositionRow = {
  symbol: string;
  assetClass: string | null;
  currency: string;
  quantity: number;
  /** Weighted-average cost per share including buy-side charges, base units. */
  avgCost: number;
  /** Latest price per share, base units (GBX folded to GBP). */
  price: number | null;
  priceSource: "broker" | "public" | "cache" | "cost" | "none";
  pricedAt: string | null;
  /** Money in the instrument's currency. */
  costBasis: number;
  marketValue: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number;
  feesPaid: number;
  /** Same three in the portfolio's base currency. */
  marketValueBase: number | null;
  unrealizedBase: number | null;
  realizedBase: number;
  costBasisBase: number;
  feesBase: number;
  /** Share of the portfolio's latest total value, 0..1. */
  weight: number | null;
  /** This symbol's measured round-trip dealing cost, bps of notional. */
  roundTripBps: number | null;
  costMeasured: boolean;
  openedAt: string | null;
  short: boolean;
};

export type PortfolioPositions = {
  portfolioId: string;
  portfolioName: string;
  currency: string;
  cash: number | null;
  nav: number | null;
  navAsOf: string | null;
  rows: PositionRow[];
  totals: {
    marketValueBase: number;
    costBasisBase: number;
    unrealizedBase: number;
    realizedBase: number;
    feesBase: number;
  };
  /** Count of rows priced off the broker's own live tape. */
  brokerPriced: number;
  warnings: string[];
};

type FillRow = {
  symbol: string;
  side: string | null;
  quantity: number | string | null;
  fill_price: number | string | null;
  fee: number | string | null;
  currency: string | null;
  filled_at: string | null;
};

export const getPortfolioPositions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ portfolioId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }): Promise<PortfolioPositions> => {
    const db = context.supabase;
    const warnings: string[] = [];

    const [{ data: portfolio }, { data: snap }, { data: holdingRows }, { data: fills }, { data: costRows }] =
      await Promise.all([
        db
          .from("portfolios")
          .select("id, name, currency, current_cash")
          .eq("id", data.portfolioId)
          .single(),
        db
          .from("equity_snapshots")
          .select("total_value, cash, snapshot_date")
          .eq("portfolio_id", data.portfolioId)
          .order("snapshot_date", { ascending: false })
          .limit(1)
          .maybeSingle(),
        db
          .from("holdings")
          .select("symbol, quantity, avg_cost, asset_class, instrument_ccy, opened_at")
          .eq("portfolio_id", data.portfolioId),
        db
          .from("live_fills")
          .select("symbol, side, quantity, fill_price, fee, currency, filled_at")
          .eq("portfolio_id", data.portfolioId)
          .order("filled_at", { ascending: true })
          .limit(5000),
        db
          .from("symbol_execution_costs")
          .select("symbol_key, round_trip_bps, measured, tickets"),
      ]);

    if (!portfolio) throw new Error("Portfolio not found");
    const base = String(portfolio.currency || "GBP").toUpperCase();
    const nav = Number(snap?.total_value ?? 0) || null;
    const cash = snap?.cash != null ? Number(snap.cash) : Number(portfolio.current_cash ?? 0) || null;

    const holdings = (holdingRows ?? []).filter((h) => Math.abs(Number(h.quantity)) > 1e-8);
    const symbols = [...new Set(holdings.map((h) => String(h.symbol)))];

    // --- Replay fills: per-symbol cost basis, realised P&L and charges. ---
    const book = new Map<string, { qty: number; cost: number; realized: number; fees: number }>();
    for (const f of (fills ?? []) as FillRow[]) {
      const qty = Math.abs(Number(f.quantity ?? 0));
      const price = Number(f.fill_price ?? 0);
      if (!(qty > 0) || !(price > 0)) continue;
      const key = engineSymbolKey(String(f.symbol ?? ""));
      if (!key) continue;
      const fee = Math.abs(Number(f.fee ?? 0)) || 0;
      const cur = book.get(key) ?? { qty: 0, cost: 0, realized: 0, fees: 0 };
      if (String(f.side ?? "buy").toLowerCase() === "sell") {
        const sold = Math.min(qty, cur.qty);
        const avg = cur.qty > 0 ? cur.cost / cur.qty : 0;
        cur.realized += sold * (price - avg) - fee;
        cur.qty = Math.max(0, cur.qty - sold);
        cur.cost = Math.max(0, cur.cost - sold * avg);
        if (cur.qty <= 1e-9) { cur.qty = 0; cur.cost = 0; }
      } else {
        // Commission is part of what the position cost us.
        cur.cost += qty * price + fee;
        cur.qty += qty;
      }
      cur.fees += fee;
      book.set(key, cur);
    }

    // --- Live prices: broker tape first, public feed for the gaps. ---
    const priceOf = new Map<string, { price: number; at: string | null; source: PositionRow["priceSource"] }>();
    let brokerPriced = 0;
    if (symbols.length > 0) {
      try {
        const { fetchBrokerQuotes } = await import("@/lib/brokers/saxo-prices.server");
        const brokerQuotes = await fetchBrokerQuotes(symbols, { portfolioId: data.portfolioId });
        for (const [sym, q] of Object.entries(brokerQuotes)) {
          if (Number.isFinite(q.price) && q.price > 0) {
            priceOf.set(sym, { price: q.price, at: q.at ?? null, source: "broker" });
            brokerPriced += 1;
          }
        }
      } catch (err) {
        console.warn("getPortfolioPositions: broker feed unavailable", err);
      }
      const missing = symbols.filter((s) => !priceOf.has(s));
      if (missing.length > 0) {
        try {
          const { fetchLiveQuotes } = await import("@/lib/live-quotes.server");
          const byPublic = new Map(missing.map((s) => [engineSymbolKey(s), s]));
          const live = await fetchLiveQuotes([...byPublic.keys()]);
          for (const [pub, q] of Object.entries(live.quotes)) {
            const holdingSymbol = byPublic.get(pub);
            if (holdingSymbol && Number.isFinite(q.price) && q.price > 0) {
              priceOf.set(holdingSymbol, { price: q.price, at: q.at ?? null, source: "public" });
            }
          }
        } catch (err) {
          console.warn("getPortfolioPositions: public feed unavailable", err);
        }
      }
      // Last resort: the most recent cached close.
      const stillMissing = symbols.filter((s) => !priceOf.has(s));
      if (stillMissing.length > 0) {
        const variants = stillMissing.flatMap((s) => priceSymbolVariants(s));
        const { data: cached } = await db
          .from("price_cache")
          .select("symbol, close, price_date")
          .in("symbol", variants)
          .order("price_date", { ascending: false })
          .limit(200);
        const byVariant = new Map<string, { close: number; date: string }>();
        for (const row of cached ?? []) {
          const k = String(row.symbol).toUpperCase();
          if (!byVariant.has(k)) byVariant.set(k, { close: Number(row.close), date: String(row.price_date) });
        }
        for (const s of stillMissing) {
          for (const v of priceSymbolVariants(s)) {
            const hit = byVariant.get(v.toUpperCase());
            if (hit && Number.isFinite(hit.close) && hit.close > 0) {
              priceOf.set(s, { price: hit.close, at: hit.date, source: "cache" });
              break;
            }
          }
        }
      }
    }

    // --- FX to the portfolio's base currency. ---
    const { majorUnitCurrency } = await import("@/lib/valuation/kernel");
    const ccyOf = new Map<string, string>();
    for (const h of holdings) {
      ccyOf.set(
        String(h.symbol),
        majorUnitCurrency(String(h.symbol), (h as { instrument_ccy?: string | null }).instrument_ccy ?? null, base),
      );
    }
    const { loadFxRates } = await import("@/lib/valuation/value-holdings.server");
    const fx = await loadFxRates([...ccyOf.values()], base);
    const toBase = (amount: number, ccy: string) =>
      ccy.toUpperCase() === base ? amount : amount * (fx.get(`${ccy.toUpperCase()}>${base}`) ?? 1);

    const costByKey = new Map<string, { roundTripBps: number; measured: boolean }>();
    for (const r of costRows ?? []) {
      if ((Number(r.tickets) || 0) > 0) {
        costByKey.set(String(r.symbol_key).toUpperCase(), {
          roundTripBps: Number(r.round_trip_bps) || 0,
          measured: Boolean(r.measured),
        });
      }
    }

    const rows: PositionRow[] = holdings.map((h) => {
      const symbol = String(h.symbol);
      const key = engineSymbolKey(symbol).toUpperCase();
      const qty = Number(h.quantity);
      const assetClass = (h as { asset_class?: string | null }).asset_class ?? null;
      const ccy = ccyOf.get(symbol) ?? base;

      const storedAvg = Number(h.avg_cost ?? 0);
      const fillAvg = (() => {
        const b = book.get(key);
        return b && b.qty > 0 && b.cost > 0 ? b.cost / b.qty : 0;
      })();
      const avgCost = storedAvg > 0 ? storedAvg : fillAvg;
      // FX spot legs are P&L-only: the currency they bought already sits in
      // the cash wallet, so their notional is not a cost basis or a value.
      const isFxLeg = isFxLegHolding({ asset_class: assetClass });
      const costBasis = isFxLeg ? 0 : Math.abs(qty) * avgCost;

      const hit = priceOf.get(symbol);
      const price = hit ? normalizeLseDisplayPriceToBase(symbol, hit.price, assetClass) : null;
      const priceSource: PositionRow["priceSource"] = hit?.source ?? (avgCost > 0 ? "cost" : "none");
      if (!hit && avgCost > 0) {
        warnings.push(`${symbol}: no live or cached price — valued at cost.`);
      }

      const marketValue =
        price != null && price > 0
          ? holdingNativeValue({ assetClass, quantity: qty, price, avgCost })
          : null;
      const unrealizedPnl =
        marketValue == null ? null : isFxLeg ? marketValue : avgCost > 0 ? marketValue - qty * avgCost : null;

      const b = book.get(key);
      const realizedPnl = b?.realized ?? 0;
      const feesPaid = b?.fees ?? 0;
      const cost = costByKey.get(key);

      return {
        symbol,
        assetClass,
        currency: ccy,
        quantity: qty,
        avgCost,
        price,
        priceSource,
        pricedAt: hit?.at ?? null,
        costBasis,
        marketValue,
        unrealizedPnl,
        realizedPnl,
        feesPaid,
        marketValueBase: marketValue != null ? toBase(marketValue, ccy) : null,
        unrealizedBase: unrealizedPnl != null ? toBase(unrealizedPnl, ccy) : null,
        realizedBase: toBase(realizedPnl, ccy),
        costBasisBase: toBase(costBasis, ccy),
        feesBase: toBase(feesPaid, ccy),
        weight: nav != null && nav > 0 && marketValue != null ? toBase(marketValue, ccy) / nav : null,
        roundTripBps: cost?.roundTripBps ?? null,
        costMeasured: cost?.measured ?? false,
        openedAt: (h as { opened_at?: string | null }).opened_at ?? null,
        short: qty < 0,
      };
    });

    rows.sort((a, b2) => Math.abs(b2.marketValueBase ?? 0) - Math.abs(a.marketValueBase ?? 0));

    const sum = (pick: (r: PositionRow) => number | null) =>
      rows.reduce((s, r) => s + (pick(r) ?? 0), 0);

    return {
      portfolioId: data.portfolioId,
      portfolioName: String(portfolio.name ?? "Portfolio"),
      currency: base,
      cash,
      nav,
      navAsOf: snap?.snapshot_date != null ? String(snap.snapshot_date) : null,
      rows,
      totals: {
        marketValueBase: sum((r) => r.marketValueBase),
        costBasisBase: sum((r) => r.costBasisBase),
        unrealizedBase: sum((r) => r.unrealizedBase),
        realizedBase: sum((r) => r.realizedBase),
        feesBase: sum((r) => r.feesBase),
      },
      brokerPriced,
      warnings,
    };
  });
