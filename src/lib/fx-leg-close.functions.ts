// "Close now" for a single open FX funding leg.
//
// Marks the leg at the live rate, applies the same one-way exit fee shown in
// the UI, converts the cash back (broker spot on live portfolios with spot FX
// enabled, wallet book-entry otherwise) and flattens the holding row so the
// Summary tab and holdings card agree immediately.

import { createServerFn } from "@tanstack/react-start";
import { requireAal2 } from "./_server/require-aal2";
import { z } from "zod";
import { parseFxPair, valueFxLeg, netClosePnl } from "./fx-leg-quotes";
import { planFxLegClose } from "./fx-leg-close-plan";
import { readWallet, writeWalletFields } from "./portfolio-wallet";
import { asJson } from "./_server/db-json";

export type CloseFxLegResult =
  | {
      ok: true;
      symbol: string;
      pair: string;
      direction: "short" | "long";
      rate: number;
      amountFrom: number;
      fromCcy: string;
      amountTo: number;
      toCcy: string;
      feeQuote: number;
      pnlQuoteNet: number;
      execution: "spot" | "wallet";
      brokerOrderId: string | null;
    }
  | { ok: false; reason: string; detail: string };

export const closeFxLeg = createServerFn({ method: "POST" })
  // Money-moving action — same TOTP step-up as manual sells and conversions.
  .middleware([requireAal2])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        symbol: z.string().min(3).max(32),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<CloseFxLegResult> => {
    const { supabase, userId } = context;
    const { getFxRateAudited } = await import("./fx.server");
    const { feeInFromCcy } = await import("./fx-cost-model");

    const [{ data: p, error: pErr }, { data: holdingRows }] = await Promise.all([
      supabase
        .from("portfolios")
        .select("id, mode, currency, current_cash, cash_by_ccy, fx_execution_mode, broker_account_id")
        .eq("id", data.portfolioId)
        .maybeSingle(),
      supabase
        .from("holdings")
        .select("id, symbol, quantity, avg_cost, instrument_ccy")
        .eq("portfolio_id", data.portfolioId)
        .eq("asset_class", "fx")
        .eq("symbol", data.symbol),
    ]);
    if (pErr || !p) return { ok: false, reason: "NOT_FOUND", detail: "Portfolio not found." };
    const holding = (holdingRows ?? [])[0];
    if (!holding || Number(holding.quantity) === 0) {
      return { ok: false, reason: "NO_LEG", detail: `No open FX leg for ${data.symbol}.` };
    }

    const baseCcy = String(p.currency ?? "GBP").toUpperCase();
    const pair = parseFxPair(String(holding.symbol), holding.instrument_ccy ?? null);
    const pairBase = (pair?.base ?? baseCcy).toUpperCase();
    const quoteCcy = (pair?.quote ?? String(holding.instrument_ccy ?? baseCcy)).toUpperCase();
    const qty = Number(holding.quantity);
    const avgCost = Number(holding.avg_cost);

    let rate: number | null = null;
    let stale = true;
    let source = "unavailable";
    try {
      const r = await getFxRateAudited(pairBase, quoteCcy);
      rate = r.rate;
      stale = r.stale;
      source = r.source;
    } catch (e) {
      return {
        ok: false,
        reason: "FX_UNAVAILABLE",
        detail: e instanceof Error ? e.message : "Could not fetch a live rate.",
      };
    }

    const v = valueFxLeg({ quantity: qty, avgCost, rate: rate ?? avgCost, quoteToBase: 1 });
    const { fee, quote: costQuote } = feeInFromCcy(v.notionalQuote, quoteCcy, pairBase, "spot");
    const net = netClosePnl({
      pnlQuote: v.pnlQuote,
      notionalQuote: v.notionalQuote,
      exitCostBps: costQuote.totalBps,
      minFeeQuote: v.notionalQuote > 0 ? Math.min(fee, costQuote.minFeeFrom) : 0,
    });

    const plan = planFxLegClose({
      quantity: qty,
      avgCost,
      rate,
      pairBase,
      quoteCcy,
      feeQuote: net.exitFeeQuote,
      stale,
    });
    if (!plan.ok) return { ok: false, reason: "PLAN_REJECTED", detail: plan.reason };

    const mode = String(p.mode ?? "");
    const isLive = mode === "live_sim" || mode === "live_prod";
    const wantSpot = isLive && p.fx_execution_mode === "spot";

    let execution: "spot" | "wallet" = "wallet";
    let brokerOrderId: string | null = null;
    let fillRate = plan.rate;
    let amountTo = plan.amountTo;

    if (wantSpot) {
      const { loadTradingGate } = await import("./trading-controls.server");
      const gate = await loadTradingGate();
      if (!gate.enabled) {
        return {
          ok: false,
          reason: "TRADING_HALTED",
          detail: gate.haltReason ?? "Trading is halted by the kill switch.",
        };
      }
      const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
      const adapter = await buildSaxoAdapter({
        userId,
        portfolioId: String(p.id),
        envOverride: mode === "live_prod" ? "live" : "sim",
        accountKey: (p as { broker_account_id?: string | null }).broker_account_id ?? undefined,
      });
      if (typeof adapter.placeFxSpot !== "function") {
        return {
          ok: false,
          reason: "SPOT_UNAVAILABLE",
          detail: "Broker adapter does not support spot FX conversions.",
        };
      }
      const spot = await adapter.placeFxSpot({
        fromCcy: plan.fromCcy,
        toCcy: plan.toCcy,
        amountFrom: plan.amountFrom,
        clientOrderId: `close-fx-${String(p.id).slice(0, 8)}-${Date.now()}`,
      });
      const spotOk = spot.status === "submitted" || spot.status === "filled";
      if (!spotOk) {
        return {
          ok: false,
          reason: "SPOT_REJECTED",
          detail: spot.reason ?? "Broker rejected the closing spot order.",
        };
      }
      execution = "spot";
      brokerOrderId = spot.brokerOrderId ?? null;
      if (typeof spot.fillRate === "number" && spot.fillRate > 0) fillRate = spot.fillRate;
      if (typeof spot.amountTo === "number" && spot.amountTo > 0) amountTo = spot.amountTo;
    }

    // Book the cash movement in the wallet either way: spot fills settle into
    // the same wallet the rest of the app reads.
    const wallet = readWallet({
      currency: p.currency,
      current_cash: p.current_cash,
      cash_by_ccy: p.cash_by_ccy as Record<string, number> | null,
    });
    const next = { ...wallet };
    next[plan.fromCcy] = Math.round(((next[plan.fromCcy] ?? 0) - plan.amountFrom) * 100) / 100;
    next[plan.toCcy] =
      Math.round(((next[plan.toCcy] ?? 0) + amountTo - (plan.toCcy === quoteCcy ? plan.feeQuote : 0)) * 100) /
      100;
    const fields = writeWalletFields(next, baseCcy);

    const { error: uErr } = await supabase
      .from("portfolios")
      .update({ cash_by_ccy: asJson(fields.cash_by_ccy), current_cash: fields.current_cash })
      .eq("id", String(p.id));
    if (uErr) return { ok: false, reason: "WALLET_WRITE_FAILED", detail: uErr.message };

    const { error: dErr } = await supabase.from("holdings").delete().eq("id", holding.id);
    if (dErr) return { ok: false, reason: "HOLDING_WRITE_FAILED", detail: dErr.message };

    // Record the close as a filled order so it appears in the order status /
    // reconciliation views alongside equity trades.
    try {
      await supabase.from("live_orders").insert({
        portfolio_id: String(p.id),
        user_id: userId,
        broker: execution === "spot" ? "saxo" : "internal",
        symbol: String(holding.symbol),
        side: qty < 0 ? "buy" : "sell",
        quantity: Math.abs(qty),
        order_type: "market",
        limit_price: fillRate,
        status: "filled",
        broker_order_id: brokerOrderId,
        client_order_id: `close-fx-${String(p.id).slice(0, 8)}-${Date.now()}`,
        instrument_ccy: quoteCcy,
        submitted_at: new Date().toISOString(),
      });
    } catch {
      // order-log write is best-effort; the wallet and holding are authoritative
    }

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: String(p.id),
        user_id: userId,
        broker: execution === "spot" ? "saxo" : "internal",
        env: mode === "live_prod" ? "live" : "sim",
        method: execution === "spot" ? "FX_LEG_CLOSE_SPOT" : "FX_LEG_CLOSE_WALLET",
        path: `/fx-leg-close/${plan.fromCcy}->${plan.toCcy}`,
        status: 200,
        request: asJson({ symbol: holding.symbol, quantity: qty, amountFrom: plan.amountFrom }),
        response: asJson({
          rate: fillRate,
          amountTo,
          feeQuote: plan.feeQuote,
          pnlQuoteNet: plan.pnlQuoteNet,
          source,
          brokerOrderId,
        }),
        error: null,
      });
    } catch {
      // audit log is best-effort
    }

    return {
      ok: true,
      symbol: String(holding.symbol),
      pair: `${pairBase}${quoteCcy}`,
      direction: plan.direction,
      rate: fillRate,
      amountFrom: plan.amountFrom,
      fromCcy: plan.fromCcy,
      amountTo,
      toCcy: plan.toCcy,
      feeQuote: plan.feeQuote,
      pnlQuoteNet: plan.pnlQuoteNet,
      execution,
      brokerOrderId,
    };
  });
