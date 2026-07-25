// Read-only preview for manual FX conversions. Returns the same shape the
// user would see after confirming (rate, destination amount, fee estimate,
// base-currency delta, and post-conversion wallet) without touching the
// broker or writing to the DB.
//
// Fees are estimated as a spread over mid-market:
//   - wallet mode: 25 bps (matches typical retail wallet FX spreads)
//   - spot mode:    5 bps (indicative Saxo SIM/live spot spread)
// The spread is applied to the source amount so the fee is denominated in
// the source currency; the destination amount reflects the post-fee rate.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { planFxConversion } from "./fx-convert-plan";
import { readWallet } from "./portfolio-wallet";

const SPREAD_BPS = { wallet: 25, spot: 5 } as const;

export const previewFxConversion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
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
    const { supabase } = context;

    const { data: p, error: pErr } = await supabase
      .from("portfolios")
      .select("id, currency, current_cash, cash_by_ccy, fx_enabled")
      .eq("id", data.portfolioId)
      .single();
    if (pErr || !p) throw new Error(pErr?.message ?? "Portfolio not found");

    const pRow = p as {
      id: string;
      currency: string | null;
      current_cash: number | null;
      cash_by_ccy: Record<string, number> | null;
      fx_enabled: boolean | null;
    };

    if (pRow.fx_enabled !== true) {
      return { ok: false as const, reason: "FX_DISABLED", detail: "Multi-currency wallet is not enabled." };
    }

    const wallet = readWallet({
      currency: pRow.currency,
      current_cash: pRow.current_cash,
      cash_by_ccy: pRow.cash_by_ccy,
    });
    const baseCcy = (pRow.currency || "GBP").toUpperCase();
    const fromCcy = data.from.toUpperCase();
    const toCcy = data.to.toUpperCase();

    const { getFxRate, getFxMatrix } = await import("./fx.server");
    const midQuote = await getFxRate(fromCcy, toCcy);
    if (!Number.isFinite(midQuote.rate) || midQuote.rate <= 0) {
      return { ok: false as const, reason: "FX_UNAVAILABLE", detail: `No FX quote for ${fromCcy}->${toCcy}.` };
    }

    const spreadBps = data.execution === "spot" ? SPREAD_BPS.spot : SPREAD_BPS.wallet;
    // Effective rate after applying half-spread to each side; single-leg
    // approximation: rate * (1 - bps/10000).
    const effectiveRate = midQuote.rate * (1 - spreadBps / 10_000);
    const feeFrom = Math.round(data.amountFrom * (spreadBps / 10_000) * 100) / 100;

    const plan = planFxConversion({
      wallet,
      from: fromCcy,
      to: toCcy,
      amountFrom: data.amountFrom,
      rate: effectiveRate,
    });
    if (!plan.ok) {
      return { ok: false as const, reason: plan.reason, detail: plan.detail };
    }

    // Base-currency impact: value the source debit and destination credit
    // in the portfolio's base currency using the current FX matrix.
    let baseCcyDelta: number | null = null;
    try {
      const matrix = await getFxMatrix([
        { from: fromCcy, to: baseCcy },
        { from: toCcy, to: baseCcy },
      ]);
      const fromToBase = matrix.get(`${fromCcy}${baseCcy}`)?.rate;
      const toToBase = matrix.get(`${toCcy}${baseCcy}`)?.rate;
      if (Number.isFinite(fromToBase) && Number.isFinite(toToBase)) {
        const debitBase = plan.amountFrom * (fromToBase as number);
        const creditBase = plan.amountTo * (toToBase as number);
        baseCcyDelta = Math.round((creditBase - debitBase) * 100) / 100;
      }
    } catch {
      baseCcyDelta = null;
    }


    return {
      ok: true as const,
      fromCcy: plan.fromCcy,
      toCcy: plan.toCcy,
      amountFrom: plan.amountFrom,
      amountTo: plan.amountTo,
      midRate: midQuote.rate,
      effectiveRate,
      spreadBps,
      feeFrom,
      feeCcy: plan.fromCcy,
      rateSource: midQuote.source,
      rateStale: midQuote.stale === true,
      baseCcy,
      baseCcyDelta,
      newWallet: plan.newWallet,
      execution: data.execution,
    };
  });
