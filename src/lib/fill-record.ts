// Resolving what actually goes into a `live_fills` row.
//
// Three reconcile paths used to write fills with `fill_price: 0` and a
// hardcoded `currency: "GBP"`:
//
//   * the Saxo /hist path, when `hist.avgPrice` was absent (`?? 0`)
//   * the presumed-fill path, when `price_cache` had no row (`|| 0`)
//   * the position-fallback path, when Saxo omitted the position currency
//
// A zero price is not a fill — it is a missing datum wearing a number's
// clothes, and downstream (realised PnL, cost basis, execution quality)
// silently treats it as a free trade. Stamping USD executions as GBP is
// the same class of bug: the value is wrong, but nothing complains.
//
// This module states the resolution rules once, purely, so all three
// call sites agree and can be regression-tested without a broker:
//
//   price     first finite, strictly-positive candidate in priority order,
//             normalised out of LSE pence into the listing's base unit
//   currency  order.instrument_ccy > venue rule for the symbol > portfolio
//             base currency (never a bare "GBP" literal)
//
// When no candidate yields a usable price the result is `null` and the
// caller must log and skip the insert rather than book a zero.

import { normalizeLseDisplayPriceToBase } from "./market-price-units";
import { instrumentCcyFor } from "./instrument-ccy-rules";
import { normaliseCcy } from "./live-order-currency";

export type FillPriceCandidate = {
  /** Where the number came from, surfaced in logs and audit rows. */
  source: string;
  value: number | string | null | undefined;
  /**
   * True when the value is a raw venue quote that may be in LSE pence
   * (price_cache closes, Saxo display prices). Values already converted
   * to the listing's base currency should set this false.
   */
  raw?: boolean;
};

export type ResolvedFillPrice = {
  fillPrice: number;
  source: string;
  /** True when the chosen candidate was not the caller's first choice. */
  fallback: boolean;
};

/**
 * Pick the first usable price from a priority-ordered candidate list.
 * Returns null when every candidate is missing, non-finite or <= 0.
 */
export function resolveFillPrice(
  symbol: string,
  candidates: FillPriceCandidate[],
): ResolvedFillPrice | null {
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const n = typeof c.value === "string" ? Number(c.value) : c.value;
    if (n === null || n === undefined || !Number.isFinite(n) || !(n > 0)) continue;
    const price = c.raw === false ? n : normalizeLseDisplayPriceToBase(symbol, n);
    if (!Number.isFinite(price) || !(price > 0)) continue;
    return { fillPrice: price, source: c.source, fallback: i > 0 };
  }
  return null;
}

/**
 * Quote units that look like ISO-4217 but are not currencies. `GBX`
 * (pence) is the dangerous one: it passes a naive 3-letter check and
 * would book an LSE fill 100x too large in a "currency" nothing else
 * understands. Reject it and let the venue rule resolve GBP instead.
 */
const NON_CURRENCY_QUOTE_UNITS = new Set(["GBX", "GBP0", "ZAC", "ILA"]);

function usableCcy(raw: string | null | undefined): string | null {
  const c = normaliseCcy(raw);
  if (!c || NON_CURRENCY_QUOTE_UNITS.has(c)) return null;
  return c;
}

/**
 * Resolve the currency a fill should be booked in.
 *
 * Never falls back to a hardcoded "GBP": the order's own
 * `instrument_ccy` is authoritative, the venue rule covers legacy rows
 * that predate that column, and the portfolio's base currency is the
 * last resort. Pence-style quote units are rejected outright.
 */
export function resolveFillCurrency(params: {
  symbol: string;
  orderCcy?: string | null;
  brokerCcy?: string | null;
  portfolioCurrency?: string | null;
}): string {
  const fromOrder = usableCcy(params.orderCcy);
  if (fromOrder) return fromOrder;
  const fromBroker = usableCcy(params.brokerCcy);
  if (fromBroker) return fromBroker;
  const base = usableCcy(params.portfolioCurrency) ?? "GBP";
  // Venue rules map .L -> GBP, US tickers -> USD, etc.
  return instrumentCcyFor(params.symbol, null, base);
}

export type ResolvedFillRecord = {
  fillPrice: number;
  currency: string;
  priceSource: string;
  fallback: boolean;
};

/**
 * Full resolution for one `live_fills` insert. Returns null when the
 * price cannot be established — callers must skip the insert and log
 * `fill_price_unavailable` instead of writing a zero.
 */
export function resolveFillRecord(params: {
  symbol: string;
  candidates: FillPriceCandidate[];
  orderCcy?: string | null;
  brokerCcy?: string | null;
  portfolioCurrency?: string | null;
}): ResolvedFillRecord | null {
  const price = resolveFillPrice(params.symbol, params.candidates);
  if (!price) return null;
  return {
    fillPrice: price.fillPrice,
    currency: resolveFillCurrency(params),
    priceSource: price.source,
    fallback: price.fallback,
  };
}
