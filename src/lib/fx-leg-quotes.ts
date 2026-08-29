// Pure maths for valuing an open FX spot funding leg at the CURRENT market
// rate, and for stating what closing it right now would realise.
//
// Why this exists: FX legs carry a negative quantity, so they were filtered
// out of the holdings price-series query and rendered with `avg_cost` as the
// "now" rate — the leg looked frozen at its entry rate with 0.00 P&L forever.
// Rates come from the FX service (ECB/er-api) rather than the equity price
// cache, which never holds pairs like GBPUSD.

export type FxPair = { base: string; quote: string };

/** "GBPUSD" / "GBP/USD" / "GBPUSD:fxspot" -> { base, quote }. */
export function parseFxPair(symbol: string, fallbackQuote?: string | null): FxPair | null {
  const s = String(symbol ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (s.length >= 6) return { base: s.slice(0, 3), quote: s.slice(3, 6) };
  if (s.length === 3 && fallbackQuote) return { base: s, quote: fallbackQuote.toUpperCase() };
  return null;
}

export type FxLegValuationInput = {
  /** Signed units of the pair's BASE currency (negative = short base). */
  quantity: number;
  /** Entry rate (quote per 1 base). */
  avgCost: number;
  /** Current market rate (quote per 1 base). */
  rate: number;
  /** Multiplier converting the quote currency into the portfolio base ccy. */
  quoteToBase: number;
};

export type FxLegValuation = {
  /** Unrealised P&L in the pair's quote currency. */
  pnlQuote: number;
  /** Same P&L expressed in the portfolio's accounting currency. */
  pnlBase: number;
  /** Absolute notional at the current rate, in the quote currency. */
  notionalQuote: number;
  notionalBase: number;
};

export function valueFxLeg(input: FxLegValuationInput): FxLegValuation {
  const qty = Number(input.quantity);
  const rate = Number(input.rate);
  const cost = Number(input.avgCost);
  const q2b = Number(input.quoteToBase);
  const ok = Number.isFinite(qty) && Number.isFinite(rate) && rate > 0;
  const pnlQuote = ok && Number.isFinite(cost) && cost > 0 ? qty * (rate - cost) : 0;
  const notionalQuote = ok ? Math.abs(qty) * rate : 0;
  const mult = Number.isFinite(q2b) && q2b > 0 ? q2b : 1;
  return {
    pnlQuote,
    pnlBase: pnlQuote * mult,
    notionalQuote,
    notionalBase: notionalQuote * mult,
  };
}

export type FxLegCloseCost = {
  /** Exit fee in the pair's quote currency (spread + any markup, min fee). */
  exitFeeQuote: number;
  /** Cost rate applied, in basis points of notional. */
  exitCostBps: number;
  /** Gross unrealised P&L minus the exit fee, in the quote currency. */
  pnlQuoteNet: number;
};

/**
 * Net "close now" P&L: gross unrealised P&L minus the one-way cost of
 * converting out of the leg (half-spread + wallet markup where applicable,
 * floored at the broker's minimum ticket fee). FX spot conversions carry no
 * stamp duty or transaction tax, so fees are the only friction to deduct.
 */
export function netClosePnl(input: {
  pnlQuote: number;
  notionalQuote: number;
  exitCostBps: number;
  minFeeQuote: number;
}): FxLegCloseCost {
  const pnl = Number(input.pnlQuote);
  const notional = Number(input.notionalQuote);
  const bps = Number(input.exitCostBps);
  const proportional =
    Number.isFinite(notional) && notional > 0 && Number.isFinite(bps) && bps > 0
      ? (notional * bps) / 10_000
      : 0;
  const minFee = Number.isFinite(input.minFeeQuote) && input.minFeeQuote > 0 ? input.minFeeQuote : 0;
  const fee = notional > 0 ? Math.max(minFee, proportional) : 0;
  const exitFeeQuote = Math.round(fee * 100) / 100;
  return {
    exitFeeQuote,
    exitCostBps: bps,
    pnlQuoteNet: Math.round(((Number.isFinite(pnl) ? pnl : 0) - exitFeeQuote) * 100) / 100,
  };
}
