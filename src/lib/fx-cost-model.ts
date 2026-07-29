// Single source of truth for FX conversion costs.
//
// Retail FX pricing at Saxo (and most brokers) has two components:
//   1) A bid/ask spread applied to the mid-market rate. Majors (EURUSD,
//      GBPUSD, USDJPY) trade tight; crosses through JPY/AUD/CAD/CHF and
//      other minors are wider; exotics are wider still.
//   2) A fixed conversion markup added on top of the spot spread when the
//      conversion is booked against a wallet balance rather than executed
//      as a live spot deal.
//
// We model both here so every code path (manual preview, AI-driven wallet
// moves, pre-buy funding legs) prices JPY/AUD trades with realistic costs
// and the AI can subtract the *round-trip* cost from its expected return
// when deciding whether a foreign entry is worth funding.
//
// All numbers are indicative and deliberately conservative — they exist to
// keep the model honest about frictions, not to reproduce broker invoices
// to the basis point. Update in one place, not scattered constants.

export type FxExecutionMode = "wallet" | "spot";

const MAJOR = new Set(["USD", "EUR", "GBP"]);
const LIQUID_MINOR = new Set(["JPY", "AUD", "CAD", "CHF"]);
// Anything not listed here is treated as an exotic and priced conservatively.
const KNOWN = new Set<string>([...MAJOR, ...LIQUID_MINOR]);

export interface FxCostQuote {
  /** Half-spread in bps applied to each leg of the conversion. */
  spreadBps: number;
  /** Extra wallet markup in bps (0 for spot execution). */
  walletMarkupBps: number;
  /** Total bps deducted from the mid rate on a single conversion. */
  totalBps: number;
  /** Minimum fee in the source currency (approx). */
  minFeeFrom: number;
  /** Human-readable classification for logging/UI. */
  pairClass: "major" | "cross-minor" | "exotic";
  execution: FxExecutionMode;
}

function classifyPair(from: string, to: string): FxCostQuote["pairClass"] {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (!KNOWN.has(f) || !KNOWN.has(t)) return "exotic";
  // A "major" pair has BOTH sides in the MAJOR set (e.g. EURUSD, GBPUSD).
  if (MAJOR.has(f) && MAJOR.has(t)) return "major";
  // Any pair touching a liquid minor (JPY/AUD/CAD/CHF) is a cross-minor.
  return "cross-minor";
}

/**
 * Per-side spread bps (i.e. bps deducted when converting from → to once).
 * Values are calibrated against typical Saxo/interactive-broker retail
 * spreads for the corresponding pair class.
 */
const SPOT_SPREAD_BPS: Record<FxCostQuote["pairClass"], number> = {
  major: 3,          // e.g. EURUSD, GBPUSD — sub-pip in normal markets
  "cross-minor": 8,  // e.g. GBPJPY, EURJPY, AUDUSD, GBPAUD
  exotic: 20,
};

/**
 * Extra markup when booking against a wallet balance (no live spot deal).
 * This matches the historical hardcoded 22bps gap between wallet (25bps)
 * and spot (5bps) — but now scaled per pair class so JPY/AUD wallet moves
 * price higher than EURUSD wallet moves.
 */
const WALLET_MARKUP_BPS: Record<FxCostQuote["pairClass"], number> = {
  major: 22,
  "cross-minor": 32,
  exotic: 50,
};

/** Minimum booked fee in the source currency, to price small conversions. */
const MIN_FEE_FROM: Record<string, number> = {
  GBP: 1,
  USD: 1,
  EUR: 1,
  CHF: 1,
  CAD: 1,
  AUD: 2,
  JPY: 150,
};

/**
 * Return the applicable spread + markup for a single from→to conversion.
 * Callers apply `totalBps` to the mid rate to get the effective rate.
 */
export function quoteFxCost(
  from: string,
  to: string,
  execution: FxExecutionMode = "wallet",
): FxCostQuote {
  const pairClass = classifyPair(from, to);
  const spreadBps = SPOT_SPREAD_BPS[pairClass];
  const walletMarkupBps = execution === "wallet" ? WALLET_MARKUP_BPS[pairClass] : 0;
  const totalBps = spreadBps + walletMarkupBps;
  const minFeeFrom = MIN_FEE_FROM[from.toUpperCase()] ?? 1;
  return { spreadBps, walletMarkupBps, totalBps, minFeeFrom, pairClass, execution };
}

/**
 * Apply the quote to a mid-market rate. Returns the rate the caller should
 * use for its plan/debit maths.
 */
export function applyFxCost(midRate: number, quote: FxCostQuote): number {
  if (!Number.isFinite(midRate) || midRate <= 0) return midRate;
  return midRate * (1 - quote.totalBps / 10_000);
}

/**
 * Absolute fee in the source currency for a given conversion size.
 * Respects the per-currency minimum so a tiny £5 sweep isn't priced at zero.
 */
export function feeInFromCcy(
  amountFrom: number,
  from: string,
  to: string,
  execution: FxExecutionMode = "wallet",
): { fee: number; quote: FxCostQuote } {
  const quote = quoteFxCost(from, to, execution);
  const proportional = amountFrom * (quote.totalBps / 10_000);
  const fee = Math.max(quote.minFeeFrom, proportional);
  return { fee: Math.round(fee * 100) / 100, quote };
}

/**
 * Estimated round-trip cost in bps for entering a foreign-currency position
 * and later closing it: base→foreign leg, plus foreign→base leg. The AI
 * consults this when deciding whether an expected return on a JPY/AUD name
 * justifies the FX drag.
 *
 * If `execution` is "wallet" for entry but the position is expected to
 * eventually unwind at spot-quality liquidity (e.g. an SGX/TSE stock sold
 * via the broker with automatic FX sweep), pass different modes per leg.
 */
export function roundTripFxBps(
  baseCcy: string,
  foreignCcy: string,
  opts?: { entry?: FxExecutionMode; exit?: FxExecutionMode },
): {
  entryBps: number;
  exitBps: number;
  totalBps: number;
  pairClass: FxCostQuote["pairClass"];
} {
  const entry = quoteFxCost(baseCcy, foreignCcy, opts?.entry ?? "wallet");
  const exit = quoteFxCost(foreignCcy, baseCcy, opts?.exit ?? "wallet");
  return {
    entryBps: entry.totalBps,
    exitBps: exit.totalBps,
    totalBps: entry.totalBps + exit.totalBps,
    pairClass: entry.pairClass,
  };
}

/**
 * Convenience for prompt-building: return one-line summaries for every
 * non-base currency in play so the AI can cite the specific cost per pair.
 */
export function summarizeRoundTripCosts(
  baseCcy: string,
  otherCcys: string[],
  execution: FxExecutionMode = "wallet",
): Array<{
  ccy: string;
  entryBps: number;
  exitBps: number;
  totalBps: number;
  pairClass: FxCostQuote["pairClass"];
}> {
  return otherCcys
    .filter((c) => c && c.toUpperCase() !== baseCcy.toUpperCase())
    .map((c) => {
      const rt = roundTripFxBps(baseCcy, c, { entry: execution, exit: execution });
      return { ccy: c.toUpperCase(), ...rt };
    });
}
