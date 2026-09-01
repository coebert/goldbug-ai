// Pure planner for "close this FX funding leg at the live rate".
//
// A leg is stored as signed BASE-currency units of the pair (GBPUSD -2325.78
// = short 2,325.78 GBP funded in USD). Flattening it is one spot conversion
// in the opposite direction:
//   short base  → buy base with quote ccy   (from = quote, to = base)
//   long  base  → sell base into quote ccy  (from = base,  to = quote)
// The `amountFrom` is always expressed in the FROM currency, which is what
// the broker's spot endpoint expects.

export type FxLegClosePlan =
  | {
      ok: true;
      pairBase: string;
      quoteCcy: string;
      direction: "short" | "long";
      fromCcy: string;
      toCcy: string;
      /** Amount to convert, in `fromCcy`. */
      amountFrom: number;
      /** Expected amount received, in `toCcy`, before fees. */
      amountTo: number;
      rate: number;
      /** Estimated one-way fee in the quote currency. */
      feeQuote: number;
      /** Realised P&L after the fee, in the quote currency. */
      pnlQuoteNet: number;
    }
  | { ok: false; reason: string };

export function planFxLegClose(input: {
  quantity: number;
  avgCost: number;
  rate: number | null;
  pairBase: string;
  quoteCcy: string;
  /** Estimated exit fee in the quote ccy (from the live quote). */
  feeQuote: number;
  /** Refuse to trade on a rate we know is stale. */
  stale?: boolean;
}): FxLegClosePlan {
  const qty = Number(input.quantity);
  const rate = Number(input.rate);
  if (!Number.isFinite(qty) || qty === 0) return { ok: false, reason: "Leg has no open quantity." };
  if (!Number.isFinite(rate) || rate <= 0) return { ok: false, reason: "No live rate for this pair." };
  if (input.stale) return { ok: false, reason: "Live rate is stale — refresh before closing." };

  const pairBase = String(input.pairBase).toUpperCase();
  const quoteCcy = String(input.quoteCcy).toUpperCase();
  if (pairBase.length !== 3 || quoteCcy.length !== 3 || pairBase === quoteCcy) {
    return { ok: false, reason: "Leg currency pair could not be resolved." };
  }

  const direction: "short" | "long" = qty < 0 ? "short" : "long";
  const baseUnits = Math.abs(qty);
  const quoteUnits = round2(baseUnits * rate);

  const fee = Number.isFinite(input.feeQuote) && input.feeQuote > 0 ? round2(input.feeQuote) : 0;
  const grossQuote = qty * (rate - Number(input.avgCost));
  const pnlQuoteNet = round2((Number.isFinite(grossQuote) ? grossQuote : 0) - fee);

  return direction === "short"
    ? {
        ok: true,
        pairBase,
        quoteCcy,
        direction,
        fromCcy: quoteCcy,
        toCcy: pairBase,
        amountFrom: quoteUnits,
        amountTo: round2(baseUnits),
        rate,
        feeQuote: fee,
        pnlQuoteNet,
      }
    : {
        ok: true,
        pairBase,
        quoteCcy,
        direction,
        fromCcy: pairBase,
        toCcy: quoteCcy,
        amountFrom: round2(baseUnits),
        amountTo: quoteUnits,
        rate,
        feeQuote: fee,
        pnlQuoteNet,
      };
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
