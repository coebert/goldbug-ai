// Manual "Sell now" server function. Liquidates a chosen percent of a single
// holding, respecting no-leverage (never sell more than owned), no-short,
// portfolio pause, and portfolio-status guards.
//
// Live modes (live_sim / live_prod) route through routeOrdersToBroker so the
// order flows through the same Saxo adapter, adaptive-buy-cap, and
// reconciliation pipeline the AI uses. Paper mode applies the sell locally
// with execution-realism fill pricing and credits the wallet in the
// instrument currency (GBX-normalised for LSE common stocks).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAal2 } from "@/lib/_server/require-aal2";
import { z } from "zod";

export type ManualSellResult = {
  ok: true;
  mode: string;
  symbol: string;
  qty: number;
  price: number;
  proceeds?: number;
  instrument_ccy: string;
  status: string;
  brokerOrderId?: string | null;
  remaining?: number;
  reason?: string | null;
};

export const manualSellHolding = createServerFn({ method: "POST" })
  .middleware([requireAal2])
  .inputValidator((input: unknown) =>
    z
      .object({
        holdingId: z.string().uuid(),
        percent: z.number().min(1).max(100),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<ManualSellResult> => {
    const { supabase, userId } = context;

    // RLS scopes both reads to the caller's portfolios.
    const { data: h, error: hErr } = await supabase
      .from("holdings")
      .select("id, portfolio_id, symbol, quantity, avg_cost, asset_class, instrument_ccy")
      .eq("id", data.holdingId)
      .maybeSingle();
    if (hErr || !h) throw new Error("Holding not found or not accessible.");

    const { data: p, error: pErr } = await supabase
      .from("portfolios")
      .select(
        "id, user_id, mode, status, currency, current_cash, cash_by_ccy, live_paused",
      )
      .eq("id", h.portfolio_id)
      .maybeSingle();
    if (pErr || !p) throw new Error("Portfolio not found or not accessible.");

    if (p.status === "complete") {
      throw new Error("Portfolio is complete — manual sells are disabled.");
    }
    if ((p.mode === "live_sim" || p.mode === "live_prod") && p.live_paused) {
      throw new Error("Live portfolio is paused. Resume it before selling.");
    }

    const qtyOwned = Number(h.quantity);
    if (!(qtyOwned > 0) || !Number.isFinite(qtyOwned)) {
      throw new Error("This position has no units to sell.");
    }

    // No-leverage / no-short invariant: quantity requested must never exceed
    // quantity held. Whole-share rounding for stocks/etfs/commodities; up to
    // 6 dp for crypto/fx. Full-liquidation always closes the position
    // exactly so no dust is left behind.
    const isFractional = h.asset_class === "crypto" || h.asset_class === "fx";
    const raw = qtyOwned * (data.percent / 100);
    let qty = isFractional ? Math.floor(raw * 1e6) / 1e6 : Math.floor(raw);
    if (data.percent >= 100) qty = qtyOwned;
    if (!(qty > 0)) {
      throw new Error(
        "Requested percent rounds down to zero sellable units — choose a larger percent.",
      );
    }
    if (qty > qtyOwned) qty = qtyOwned;

    // Latest close from cache. Holdings are broker-native ("MKS:xlon") while
    // price_cache is keyed on the universe symbol ("MKS.L"), so match on every
    // variant — an exact-symbol lookup silently missed and fell back to avg
    // cost, repricing exits above the market so they could never fill.
    const { priceSymbolVariants } = await import("@/lib/price-symbol");
    const { normalizeLseDisplayPriceToBase: toBase } = await import(
      "@/lib/market-price-units"
    );
    const { data: pc } = await supabase
      .from("price_cache")
      .select("close, price_date")
      .in("symbol", priceSymbolVariants(h.symbol))
      .order("price_date", { ascending: false })
      .limit(1);
    const cachedClose = pc && pc[0] ? Number(pc[0].close) : NaN;
    // price_cache quotes LSE stocks in pence; the engine and broker paths work
    // in the instrument's base unit.
    const cachedBase =
      Number.isFinite(cachedClose) && cachedClose > 0
        ? toBase(h.symbol, cachedClose, h.asset_class)
        : NaN;
    const price =
      Number.isFinite(cachedBase) && cachedBase > 0 ? cachedBase : Number(h.avg_cost);

    const instrumentCcy = (h.instrument_ccy || p.currency || "GBP").toUpperCase();
    const asOf = new Date().toISOString().slice(0, 10);


    // Live routing — reuse the same broker adapter, adaptive caps, and
    // reconciliation the AI already exercises.
    if (p.mode === "live_sim" || p.mode === "live_prod") {
      const { routeOrdersToBroker } = await import("@/lib/live-executor.server");
      const results = await routeOrdersToBroker({
        portfolio: { id: p.id, mode: p.mode, live_paused: p.live_paused },
        userId,
        asOf,
        decisionId: null,
        executed: [
          {
            symbol: h.symbol,
            side: "sell",
            quantity: qty,
            price,
            reason: `Manual sell: ${data.percent}% of position`,
            instrument_ccy: instrumentCcy,
          },
        ],
      });
      const r = results[0];
      return {
        ok: true,
        mode: p.mode,
        symbol: h.symbol,
        qty,
        price,
        instrument_ccy: instrumentCcy,
        status: r?.status ?? "submitted",
        brokerOrderId: r?.brokerOrderId ?? null,
        reason: r?.reason ?? r?.skipped ?? null,
      };
    }

    // Paper / backtest / live_sim-paper-only path — apply locally.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { applySellExecution } = await import("@/lib/execution-realism.server");
    const { normalizeLseDisplayPriceToBase } = await import(
      "@/lib/market-price-units"
    );
    const { readWallet, applyDelta, writeWalletFields } = await import(
      "@/lib/portfolio-wallet"
    );

    const sell = applySellExecution({
      qty,
      price,
      atrPct: null,
      assetClass: (h.asset_class ?? undefined) as
        | "stock"
        | "etf"
        | "crypto"
        | "commodity"
        | "fx"
        | undefined,
      currency: instrumentCcy,
    });

    // Fold GBX pence into GBP for cash proceeds when the instrument is
    // an LSE common stock (its native quote is pence even though
    // instrument_ccy is "GBP"). Non-GBP instruments already report in
    // their native major unit.
    const proceedsInInstrumentCcy =
      instrumentCcy === "GBP"
        ? normalizeLseDisplayPriceToBase(h.symbol, sell.proceedsNet, h.asset_class)
        : sell.proceedsNet;

    const baseCcy = String(p.currency || "GBP").toUpperCase();
    const wallet = readWallet({
      currency: baseCcy,
      current_cash: Number(p.current_cash),
      cash_by_ccy: (p.cash_by_ccy as Record<string, number> | null) ?? null,
    });
    const next = applyDelta(wallet, instrumentCcy, proceedsInInstrumentCcy);
    const walletWrite = writeWalletFields(next, baseCcy);

    const remaining = qtyOwned - qty;
    if (remaining <= 1e-8) {
      await supabaseAdmin.from("holdings").delete().eq("id", h.id);
    } else {
      await supabaseAdmin
        .from("holdings")
        .update({ quantity: remaining, updated_at: new Date().toISOString() })
        .eq("id", h.id);
    }

    await supabaseAdmin.from("trades").insert({
      portfolio_id: p.id,
      symbol: h.symbol,
      asset_class: h.asset_class,
      side: "sell",
      quantity: qty,
      price: sell.fillPrice,
      value: qty * sell.fillPrice,
      executed_at: new Date().toISOString(),
      trade_date: asOf,
      reason: `Manual sell: ${data.percent}% of position`,
      instrument_ccy: instrumentCcy,
    });

    await supabaseAdmin
      .from("portfolios")
      .update({
        current_cash: walletWrite.current_cash,
        cash_by_ccy: walletWrite.cash_by_ccy,
        updated_at: new Date().toISOString(),
      })
      .eq("id", p.id);

    return {
      ok: true,
      mode: p.mode,
      symbol: h.symbol,
      qty,
      price: sell.fillPrice,
      proceeds: proceedsInInstrumentCcy,
      instrument_ccy: instrumentCcy,
      remaining,
      status: "filled",
    };
  });
