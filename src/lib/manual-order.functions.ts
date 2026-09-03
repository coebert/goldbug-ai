// Manual order ticket: place a real broker order from the Trade page.
//
// The Trade page could only ever sell an existing holding; anything else was
// simulated locally. This routes a hand-entered buy or sell through exactly
// the same path the AI uses — `routeOrdersToBroker` — so the order hits Saxo,
// lands in `live_orders`, and is picked up by the normal fill reconciler.
// Nothing here is a paper shortcut: non-live portfolios are refused outright
// rather than pretending to trade.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAal2 } from "@/lib/_server/require-aal2";

export type ManualOrderQuote = {
  symbol: string;
  /** Price in the instrument's major unit (GBP, not pence). */
  price: number | null;
  bid: number | null;
  ask: number | null;
  currency: string;
  source: "broker" | "cache" | "unavailable";
  at: string | null;
};

/** Live price for a hand-typed symbol, so the ticket shows what it will pay. */
export const getManualOrderQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        symbol: z.string().min(1).max(32),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<ManualOrderQuote> => {
    const symbol = data.symbol.trim();
    const { normalizeLseDisplayPriceToBase } = await import("@/lib/market-price-units");
    const { priceSymbolVariants } = await import("@/lib/price-symbol");

    try {
      const { fetchBrokerQuote } = await import("@/lib/brokers/saxo-prices.server");
      const q = await fetchBrokerQuote(symbol, { portfolioId: data.portfolioId });
      if (q && Number.isFinite(q.price) && q.price > 0) {
        const toBase = (v: number | null) =>
          v == null || !Number.isFinite(v) ? null : normalizeLseDisplayPriceToBase(symbol, v);
        return {
          symbol,
          price: toBase(q.price),
          bid: toBase(q.bid),
          ask: toBase(q.ask),
          currency: q.currency,
          source: "broker",
          at: q.at,
        };
      }
    } catch (err) {
      console.warn("getManualOrderQuote: broker quote failed", err);
    }

    const { data: pc } = await context.supabase
      .from("price_cache")
      .select("close, price_date")
      .in("symbol", priceSymbolVariants(symbol))
      .order("price_date", { ascending: false })
      .limit(1);
    const close = pc && pc[0] ? Number(pc[0].close) : NaN;
    const { instrumentCcyFor } = await import("@/lib/instrument-ccy-rules");
    if (Number.isFinite(close) && close > 0) {
      return {
        symbol,
        price: normalizeLseDisplayPriceToBase(symbol, close),
        bid: null,
        ask: null,
        currency: instrumentCcyFor(symbol, null, "GBP"),
        source: "cache",
        at: (pc?.[0]?.price_date as string) ?? null,
      };
    }
    return {
      symbol,
      price: null,
      bid: null,
      ask: null,
      currency: instrumentCcyFor(symbol, null, "GBP"),
      source: "unavailable",
      at: null,
    };
  });

export type ManualOrderResult = {
  ok: boolean;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  instrumentCcy: string;
  status: string;
  brokerOrderId?: string | null;
  reason?: string | null;
};

export const placeManualOrder = createServerFn({ method: "POST" })
  .middleware([requireAal2])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        symbol: z.string().min(1).max(32),
        side: z.enum(["buy", "sell"]),
        quantity: z.number().positive().max(1_000_000),
        /** Optional working price; the executor prices the order when omitted. */
        limitPrice: z.number().positive().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<ManualOrderResult> => {
    const { supabase, userId } = context;
    const symbol = data.symbol.trim();

    const { data: p } = await supabase
      .from("portfolios")
      .select("id, mode, status, currency, live_paused")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (!p) throw new Error("Portfolio not found or not accessible.");
    if (p.status === "complete") {
      throw new Error("Portfolio is complete — manual orders are disabled.");
    }
    if (p.mode !== "live_sim" && p.mode !== "live_prod") {
      throw new Error(
        "This portfolio is not connected to the broker, so an order here would only be simulated. Switch to the live account to place a real order.",
      );
    }
    if (p.live_paused) {
      throw new Error("Live trading is paused. Resume it before placing an order.");
    }

    // A sell can never exceed what is held: no shorting, no leverage.
    if (data.side === "sell") {
      const { data: h } = await supabase
        .from("holdings")
        .select("quantity")
        .eq("portfolio_id", p.id)
        .eq("symbol", symbol)
        .maybeSingle();
      const owned = Number(h?.quantity ?? 0);
      if (!(owned > 0)) throw new Error(`No ${symbol} position to sell.`);
      if (data.quantity > owned + 1e-8) {
        throw new Error(`Only ${owned} ${symbol} held — reduce the quantity.`);
      }
    }

    // Price the ticket: the broker quote is the truth, the cached close is the
    // fallback, and an explicit limit always wins.
    let price = data.limitPrice ?? 0;
    if (!(price > 0)) {
      const { normalizeLseDisplayPriceToBase } = await import("@/lib/market-price-units");
      try {
        const { fetchBrokerQuote } = await import("@/lib/brokers/saxo-prices.server");
        const q = await fetchBrokerQuote(symbol, { portfolioId: p.id });
        if (q && q.price > 0) price = normalizeLseDisplayPriceToBase(symbol, q.price);
      } catch {
        /* fall through to the cache */
      }
      if (!(price > 0)) {
        const { priceSymbolVariants } = await import("@/lib/price-symbol");
        const { data: pc } = await supabase
          .from("price_cache")
          .select("close")
          .in("symbol", priceSymbolVariants(symbol))
          .order("price_date", { ascending: false })
          .limit(1);
        const close = pc && pc[0] ? Number(pc[0].close) : NaN;
        if (Number.isFinite(close) && close > 0) {
          price = normalizeLseDisplayPriceToBase(symbol, close);
        }
      }
    }
    if (!(price > 0)) {
      throw new Error(`No price available for ${symbol} — cannot size the order safely.`);
    }

    const { instrumentCcyFor } = await import("@/lib/instrument-ccy-rules");
    const instrumentCcy = instrumentCcyFor(symbol, null, String(p.currency || "GBP"));

    const { routeOrdersToBroker } = await import("@/lib/live-executor.server");
    const results = await routeOrdersToBroker({
      portfolio: { id: p.id, mode: p.mode, live_paused: p.live_paused },
      userId,
      asOf: new Date().toISOString().slice(0, 10),
      decisionId: null,
      executed: [
        {
          symbol,
          side: data.side,
          quantity: data.quantity,
          price,
          reason: `Manual ${data.side} from the trade ticket`,
          instrument_ccy: instrumentCcy,
        },
      ],
    });
    const r = results[0];
    const status = r?.status ?? "not_routed";
    return {
      ok: status !== "rejected" && status !== "error" && status !== "not_routed",
      symbol,
      side: data.side,
      quantity: data.quantity,
      price,
      instrumentCcy,
      status,
      brokerOrderId: r?.brokerOrderId ?? null,
      reason: r?.reason ?? r?.skipped ?? null,
    };
  });
