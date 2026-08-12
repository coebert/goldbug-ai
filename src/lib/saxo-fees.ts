// Saxo Bank "Classic" tier fee schedule (published rates, 2026).
//
// The trading engine used to model a single flat commission_bps (default
// 5bps) with no floor. That understates Saxo's real cost in two ways:
//
//   1. Saxo charges a MINIMUM commission per trade (e.g. £3 UK stocks,
//      $1 US, €3 EU). On small orders the minimum dominates the % rate,
//      so a £100 BUY actually costs 3% not 5bps.
//   2. Different venues use different rates. UK stocks are 0.08%, US
//      $0.02/share (~10bps on typical prices), EU ~0.08%, Swiss ~0.10%.
//
// This module is pure and I/O-free so it stays trivially testable. Callers
// derive the trade currency from the Yahoo suffix and pass notional + asset
// class; we return the estimated per-side commission in trade currency plus
// a bps view for the engine's breakeven-vs-fee guard.
//
// Sources: saxobank.com/pricing — retail Classic tier for stocks/ETFs/ETPs.
// Numbers are conservative (rounded up where a range is quoted) so the guard
// never under-estimates cost.

import type { AssetClass } from "./universe.server";

export type SaxoVenueTier = {
  /** Human label for logs. */
  venue: string;
  /** ISO 4217 trade currency (e.g. GBP, USD, EUR, CHF). */
  currency: string;
  /** Per-side commission as a fraction of notional (e.g. 0.0008 = 8bps). */
  rate: number;
  /** Minimum per-side commission in trade currency. */
  min: number;
  /** Optional cap — 0 means no cap. */
  cap?: number;
};

/**
 * Saxo Classic per-venue schedule keyed by trade currency. When multiple
 * venues share a currency (e.g. Xetra + Euronext both EUR) we keep the
 * conservative common rate.
 */
export const SAXO_FEE_SCHEDULE: Record<string, SaxoVenueTier> = {
  GBP: { venue: "LSE",   currency: "GBP", rate: 0.0008, min: 3 },
  USD: { venue: "US",    currency: "USD", rate: 0.0008, min: 1 },
  EUR: { venue: "EU",    currency: "EUR", rate: 0.0008, min: 3 },
  CHF: { venue: "SIX",   currency: "CHF", rate: 0.0010, min: 3 },
  JPY: { venue: "TSE",   currency: "JPY", rate: 0.0015, min: 1500 },
  HKD: { venue: "HKEX",  currency: "HKD", rate: 0.0015, min: 45 },
  AUD: { venue: "ASX",   currency: "AUD", rate: 0.0008, min: 8 },
  CAD: { venue: "TSX",   currency: "CAD", rate: 0.0008, min: 8 },
  DKK: { venue: "OMX",   currency: "DKK", rate: 0.0008, min: 20 },
  SEK: { venue: "OMX",   currency: "SEK", rate: 0.0008, min: 30 },
  NOK: { venue: "OSL",   currency: "NOK", rate: 0.0008, min: 30 },
};

const DEFAULT_TIER: SaxoVenueTier = {
  venue: "default",
  currency: "USD",
  rate: 0.0010,
  min: 3,
};

/**
 * Infer the trade currency from a Yahoo-style ticker. Kept in sync with the
 * conventions used throughout `universe.server.ts`.
 *
 *   .L / .LON     → GBP
 *   .DE / .F      → EUR
 *   .PA / .AS / .MI / .MC / .BR / .LS → EUR
 *   .SW           → CHF
 *   .T  / .TO?    → JPY
 *   .HK           → HKD
 *   .AX           → AUD
 *   .TO / .V      → CAD
 *   .CO           → DKK
 *   .ST           → SEK
 *   .OL           → NOK
 *   BTC-USD / FX  → USD (spot pairs)
 *   bare / no dot → USD (US listings)
 */
/** Broker-native MIC suffixes (`MKS:xlon`) → trade currency. */
const MIC_CURRENCY: Record<string, string> = {
  XLON: "GBP", LSE: "GBP", XLOD: "GBP",
  XNAS: "USD", XNYS: "USD", ARCX: "USD", BATS: "USD", XASE: "USD",
  XETR: "EUR", XFRA: "EUR", XPAR: "EUR", XAMS: "EUR", XMIL: "EUR",
  XMAD: "EUR", XBRU: "EUR", XLIS: "EUR", XHEL: "EUR", XDUB: "EUR",
  XSWX: "CHF", XVTX: "CHF",
  XCSE: "DKK", XSTO: "SEK", XOSL: "NOK",
  XTKS: "JPY", XHKG: "HKD", XASX: "AUD", XTSE: "CAD",
};

export function inferSaxoCurrency(symbol: string): string {
  const s = symbol.toUpperCase();
  // FX and crypto spot pairs quote in USD by convention here.
  if (s.endsWith("=X")) return "USD";
  if (s.endsWith("-USD")) return "USD";
  // Broker-native form: TICKER:MIC. Saxo holdings and orders use this, so it
  // must resolve as precisely as the Yahoo-style suffix — otherwise UK names
  // look like US dollars and their 0.5% stamp duty is never charged.
  const colon = s.lastIndexOf(":");
  if (colon > 0) {
    const mic = MIC_CURRENCY[s.slice(colon + 1)];
    if (mic) return mic;
  }
  const dot = s.lastIndexOf(".");
  if (dot < 0) return "USD";
  const suffix = s.slice(dot + 1);

  switch (suffix) {
    case "L":
    case "LON":
      return "GBP";
    case "DE":
    case "F":
    case "PA":
    case "AS":
    case "MI":
    case "MC":
    case "BR":
    case "LS":
      return "EUR";
    case "SW":
      return "CHF";
    case "T":
      return "JPY";
    case "HK":
      return "HKD";
    case "AX":
      return "AUD";
    case "TO":
    case "V":
      return "CAD";
    case "CO":
      return "DKK";
    case "ST":
      return "SEK";
    case "OL":
      return "NOK";
    default:
      return "USD";
  }
}

export type SaxoFeeEstimate = {
  /** Per-side commission in trade currency. */
  commission: number;
  /** True when the min-commission floor is what set the fee (vs the bps rate). */
  minFloorApplied: boolean;
  /** Per-side commission expressed as bps of the passed notional. */
  perSideBps: number;
  /** Round-trip (buy + sell) cost as bps of notional. */
  roundTripBps: number;
  tier: SaxoVenueTier;
};

/**
 * Estimate the per-side Saxo commission for a hypothetical trade of
 * `notional` (in trade currency). Notional at or below zero returns the
 * minimum floor and an infinite bps view so callers can immediately reject.
 */
export function estimateSaxoCommission(args: {
  notional: number;
  currency?: string | null;
  symbol?: string | null;
  assetClass?: AssetClass | null;
}): SaxoFeeEstimate {
  const ccy = (args.currency
    ?? (args.symbol ? inferSaxoCurrency(args.symbol) : "USD")
  ).toUpperCase();
  const tier = SAXO_FEE_SCHEDULE[ccy] ?? DEFAULT_TIER;
  const notional = Math.max(0, Number(args.notional) || 0);
  const bpsCost = notional * tier.rate;
  let commission = Math.max(tier.min, bpsCost);
  if (tier.cap && tier.cap > 0) commission = Math.min(commission, tier.cap);
  const minFloorApplied = bpsCost < tier.min;
  const perSideBps = notional > 0 ? (commission / notional) * 10_000 : Number.POSITIVE_INFINITY;
  return {
    commission,
    minFloorApplied,
    perSideBps,
    roundTripBps: perSideBps * 2,
    tier,
  };
}

/**
 * Convenience — the minimum notional (in trade currency) at which the
 * commission rate takes over from the minimum floor. Anything smaller pays
 * more than the headline % and is a candidate for rejection.
 */
export function saxoBreakevenNotional(currency: string): number {
  const tier = SAXO_FEE_SCHEDULE[currency.toUpperCase()] ?? DEFAULT_TIER;
  return tier.rate > 0 ? tier.min / tier.rate : Number.POSITIVE_INFINITY;
}
