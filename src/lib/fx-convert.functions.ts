// Phase D — user-initiated cash conversions between currencies inside a
// single portfolio wallet. Complements the executor's automatic FX legs
// (Phase B synthetic + Phase C spot) by giving the user a manual button
// to shift cash between currencies without opening any equity trade.
//
// Two execution modes:
//   - "wallet"  → pure book entry using our own FX quote (Yahoo/Frankfurter).
//                 Always available.
//   - "spot"    → real broker spot FX via BrokerAdapter.placeFxSpot(). Only
//                 allowed on live_sim/live_prod portfolios whose
//                 `fx_execution_mode` is "spot" and whose adapter implements
//                 the optional method.
//
// The pure planning math is in `./fx-convert-plan` and is fully unit-tested.
// This file is the thin server-fn wrapper: auth, DB reads/writes, broker
// call, and audit-log write.

import { createServerFn } from "@tanstack/react-start";
import { requireAal2 } from "./_server/require-aal2";
import { z } from "zod";
import { planFxConversion } from "./fx-convert-plan";
import { readWallet, writeWalletFields } from "./portfolio-wallet";
import { asJson } from "./_server/db-json";

export const convertPortfolioCash = createServerFn({ method: "POST" })
  // Money-moving action: requires the same TOTP step-up as manual sells /
  // going live, so a stolen single-factor session cannot convert cash.
  .middleware([requireAal2])
  .inputValidator((input: unknown) => {
    return z
      .object({
        portfolioId: z.string().uuid(),
        from: z.string().length(3),
        to: z.string().length(3),
        amountFrom: z.number().positive().finite(),
        execution: z.enum(["wallet", "spot"]).default("wallet"),
      })
      .parse(input);
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // RLS-scoped read of the caller's portfolio.
    const { data: p, error: pErr } = await supabase
      .from("portfolios")
      .select(
        "id, mode, currency, current_cash, cash_by_ccy, fx_enabled, fx_execution_mode, broker, broker_account_id",
      )
      .eq("id", data.portfolioId)
      .single();
    if (pErr || !p) throw new Error(pErr?.message ?? "Portfolio not found");

    const pRow = p as {
      id: string;
      mode: string | null;
      currency: string | null;
      current_cash: number | null;
      cash_by_ccy: Record<string, number> | null;
      fx_enabled: boolean | null;
      fx_execution_mode: string | null;
    };

    if (pRow.fx_enabled !== true) {
      return {
        ok: false as const,
        reason: "FX_DISABLED",
        detail: "Multi-currency wallet is not enabled on this portfolio.",
      };
    }

    const wallet = readWallet({
      currency: pRow.currency,
      current_cash: pRow.current_cash,
      cash_by_ccy: pRow.cash_by_ccy,
    });
    const baseCcy = (pRow.currency || "GBP").toUpperCase();

    // Determine which mode we actually run in. Spot is opt-in AND requires
    // a live portfolio whose adapter implements placeFxSpot.
    const wantSpot = data.execution === "spot";
    const spotEligible =
      wantSpot &&
      pRow.fx_execution_mode === "spot" &&
      (pRow.mode === "live_sim" || pRow.mode === "live_prod");

    let rate: number;
    let source: string;
    let stale = false;
    let brokerOrderId: string | null = null;
    let pairSymbol: string | null = null;
    let amountTo: number | null = null;

    if (spotEligible) {
      // Real broker spot conversion.
      const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
      const adapter = await buildSaxoAdapter({
        userId,
        portfolioId: pRow.id,
        envOverride: pRow.mode === "live_prod" ? "live" : "sim",
        accountKey: (pRow as { broker_account_id?: string | null }).broker_account_id ?? undefined,
      });
      if (typeof adapter.placeFxSpot !== "function") {
        return {
          ok: false as const,
          reason: "SPOT_UNAVAILABLE",
          detail: "Broker adapter does not support spot FX conversions.",
        };
      }
      const clientOrderId = `manual-fx-${pRow.id}-${Date.now()}`;
      const spot = await adapter.placeFxSpot({
        fromCcy: data.from.toUpperCase(),
        toCcy: data.to.toUpperCase(),
        amountFrom: data.amountFrom,
        clientOrderId,
      });
      const spotOk = spot.status === "submitted" || spot.status === "filled";
      if (!spotOk || typeof spot.fillRate !== "number" || spot.fillRate <= 0) {
        return {
          ok: false as const,
          reason: "SPOT_REJECTED",
          detail: spot.reason ?? "Broker rejected the spot FX order.",
        };
      }
      rate = spot.fillRate;
      source = "broker:spot";
      brokerOrderId = spot.brokerOrderId ?? null;
      pairSymbol = spot.pairSymbol ?? null;
      amountTo = typeof spot.amountTo === "number" ? spot.amountTo : null;
    } else {
      // Wallet mode: quote from our FX layer.
      const { getFxRate } = await import("./fx.server");
      const q = await getFxRate(data.from, data.to);
      rate = q.rate;
      source = `wallet:${q.source}`;
      stale = q.stale;
      if (!Number.isFinite(rate) || rate <= 0 || stale) {
        return {
          ok: false as const,
          reason: "FX_UNAVAILABLE",
          detail: `FX quote unavailable or stale (source: ${q.source}).`,
        };
      }
    }

    const plan = planFxConversion({
      wallet,
      from: data.from,
      to: data.to,
      amountFrom: data.amountFrom,
      rate,
    });
    if (!plan.ok) {
      return {
        ok: false as const,
        reason: plan.reason,
        detail: plan.detail,
      };
    }

    // If the broker returned an explicit destination amount, prefer it —
    // fillRate * amountFrom can drift by a rounding unit.
    if (amountTo !== null && Number.isFinite(amountTo) && amountTo > 0) {
      plan.amountTo = amountTo;
      plan.newWallet[plan.toCcy] =
        (plan.newWallet[plan.toCcy] ?? 0) - Math.round(plan.amountFrom * rate * 100) / 100 + amountTo;
    }

    const fields = writeWalletFields(plan.newWallet, baseCcy);
    const { error: uErr } = await supabase
      .from("portfolios")
      .update({
        cash_by_ccy: asJson(fields.cash_by_ccy),
        current_cash: fields.current_cash,
      })
      .eq("id", pRow.id);
    if (uErr) throw new Error(uErr.message);

    // Best-effort audit log entry (broker log = uniform audit trail).
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: pRow.id,
        user_id: userId,
        broker: spotEligible ? "saxo" : "internal",
        env: pRow.mode === "live_prod" ? "live" : "sim",
        method: spotEligible ? "FX_CONVERT_MANUAL_SPOT" : "FX_CONVERT_MANUAL_WALLET",
        path: `/manual-fx/${plan.fromCcy}->${plan.toCcy}`,
        status: 200,
        request: asJson({
          amountFrom: plan.amountFrom,
          from: plan.fromCcy,
          to: plan.toCcy,
          execution: spotEligible ? "spot" : "wallet",
        }),
        response: asJson({
          rate,
          amountTo: plan.amountTo,
          source,
          stale,
          brokerOrderId,
          pairSymbol,
        }),
        error: null,
      });
    } catch {
      // audit log write is best-effort
    }

    return {
      ok: true as const,
      fromCcy: plan.fromCcy,
      toCcy: plan.toCcy,
      amountFrom: plan.amountFrom,
      amountTo: plan.amountTo,
      rate,
      source,
      newWallet: fields.cash_by_ccy,
    };
  });
