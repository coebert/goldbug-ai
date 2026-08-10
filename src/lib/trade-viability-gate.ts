// Pre-placement trade viability gate.
//
// Problem this solves: the live executor was firing very small tickets
// (production average notional ≈ £75) into a broker whose *minimum* per-side
// commission is £3 / $1. A £75 UK buy pays £3 commission = 400bps one way,
// ~800bps round trip, plus 50bps UK stamp duty and the half-spread. No alpha
// model in this app claims an edge anywhere near that, so those trades are
// guaranteed negative expected value regardless of how good the signal is.
//
// The gate is deliberately *pure* and I/O-free: callers pass the rounded
// quantity and the price actually being routed, and get back a decision plus
// a full cost breakdown for logging/TCA.
//
// Costs modelled per side:
//   * Saxo commission (bps rate with the per-venue minimum floor)  – saxo-fees
//   * UK stamp duty 0.5% on BUYs of UK-incorporated shares (ETFs exempt)
//   * PTM levy £1 flat on UK trades with consideration > £10,000
//   * Half-spread crossed by a market order
//
// The budget is expressed in bps of notional and compared against the
// *round-trip* friction, because every buy implies an eventual sell.

import { estimateSaxoCommission, inferSaxoCurrency } from "./saxo-fees";

/** Default round-trip friction budget (bps of notional) for a new position. */
export const DEFAULT_ROUND_TRIP_BUDGET_BPS = 150;

/** UK stamp duty reserve tax on purchases of UK-incorporated shares. */
export const UK_STAMP_DUTY_BPS = 50;

/** PTM (Panel on Takeovers and Mergers) levy: £1 flat above this threshold. */
export const PTM_LEVY_THRESHOLD_GBP = 10_000;
export const PTM_LEVY_GBP = 1;

/**
 * LSE-listed instruments that are NOT liable to stamp duty: ETFs/ETCs (Irish
 * or Luxembourg domiciled), gilts, and AIM-listed shares. Matched on ticker
 * root so the rule reads at the call site.
 */
const STAMP_DUTY_EXEMPT_ROOTS = new Set([
  // Vanguard / iShares / Invesco / WisdomTree UCITS ETFs & ETCs
  "VUKE", "VMID", "VUSA", "VWRL", "VHYL", "VEUR", "VJPN", "VFEM", "VEVE",
  "VAGP", "VGOV", "VERX", "VDPX", "VWRP", "VUAG",
  "ISF", "IUKD", "IWDG", "IGLT", "SGLN", "SGLP", "IUSA", "CSP1", "EQQQ",
]);

function lseRoot(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.endsWith(":XLON")) return s.slice(0, -5);
  if (s.endsWith(".L")) return s.slice(0, -2);
  return s;
}

export function isUkListed(symbol: string): boolean {
  return inferSaxoCurrency(symbol) === "GBP";
}

/** True when a BUY of this symbol attracts 0.5% UK stamp duty. */
export function attractsStampDuty(symbol: string, assetClass?: string | null): boolean {
  if (!isUkListed(symbol)) return false;
  if (assetClass === "etf" || assetClass === "commodity") return false;
  return !STAMP_DUTY_EXEMPT_ROOTS.has(lseRoot(symbol));
}

export type TradeCostBreakdown = {
  /** Notional in trade currency. */
  notional: number;
  commission: number;
  commissionBps: number;
  stampDuty: number;
  stampDutyBps: number;
  ptmLevy: number;
  ptmLevyBps: number;
  halfSpread: number;
  halfSpreadBps: number;
  /** One-way total in trade currency. */
  oneWayCost: number;
  oneWayBps: number;
  /**
   * Round-trip friction in bps: this side's cost plus the estimated cost of
   * the eventual closing trade (commission + half-spread, no stamp duty).
   */
  roundTripBps: number;
};

export type ViabilityInput = {
  symbol: string;
  side: "buy" | "sell";
  /** Whole-share quantity actually being routed. */
  quantity: number;
  /** Price per share in the instrument's trade currency. */
  price: number;
  assetClass?: string | null;
  /** Estimated full bid/ask spread in bps. Defaults to a conservative 10bps. */
  spreadBps?: number;
  /** Round-trip friction budget in bps. */
  budgetBps?: number;
};

export type ViabilityResult = {
  viable: boolean;
  /** Human-readable skip reason when not viable. */
  reason?: string;
  budgetBps: number;
  costs: TradeCostBreakdown;
  /**
   * Smallest notional (trade currency) that would clear the budget, so the
   * caller can log "size up to X or skip".
   */
  minViableNotional: number;
};

const DEFAULT_SPREAD_BPS = 10;

export function estimateTradeCosts(input: ViabilityInput): TradeCostBreakdown {
  const notional = Math.max(0, input.quantity * input.price);
  const currency = inferSaxoCurrency(input.symbol);
  const fee = estimateSaxoCommission({
    notional,
    symbol: input.symbol,
    assetClass: (input.assetClass ?? "stock") as never,
  });
  const commission = fee.commission;

  const stampDuty =
    input.side === "buy" && attractsStampDuty(input.symbol, input.assetClass)
      ? (notional * UK_STAMP_DUTY_BPS) / 10_000
      : 0;

  const ptmLevy =
    currency === "GBP" && notional > PTM_LEVY_THRESHOLD_GBP ? PTM_LEVY_GBP : 0;

  const spreadBps = input.spreadBps ?? DEFAULT_SPREAD_BPS;
  const halfSpread = (notional * spreadBps) / 2 / 10_000;

  const bps = (v: number) => (notional > 0 ? (v / notional) * 10_000 : Infinity);
  const oneWayCost = commission + stampDuty + ptmLevy + halfSpread;

  // The closing trade pays commission + half-spread again (never stamp duty).
  const exitCost = commission + halfSpread;

  return {
    notional,
    commission,
    commissionBps: bps(commission),
    stampDuty,
    stampDutyBps: bps(stampDuty),
    ptmLevy,
    ptmLevyBps: bps(ptmLevy),
    halfSpread,
    halfSpreadBps: bps(halfSpread),
    oneWayCost,
    oneWayBps: bps(oneWayCost),
    roundTripBps: bps(oneWayCost + exitCost),
  };
}

/**
 * Smallest notional at which round-trip friction fits the budget, given the
 * fixed commission floor and the proportional costs. Solved analytically:
 *
 *   roundTrip = 2*floor + notional*(2*rate + spread + stamp) <= budget*notional
 */
export function minViableNotional(args: {
  symbol: string;
  side: "buy" | "sell";
  assetClass?: string | null;
  spreadBps?: number;
  budgetBps?: number;
}): number {
  const budgetBps = args.budgetBps ?? DEFAULT_ROUND_TRIP_BUDGET_BPS;
  const spreadBps = args.spreadBps ?? DEFAULT_SPREAD_BPS;
  const probe = estimateSaxoCommission({
    notional: 1_000_000,
    symbol: args.symbol,
    assetClass: (args.assetClass ?? "stock") as never,
  });
  const rateBps = probe.perSideBps; // floor is irrelevant at £1m
  const stampBps =
    args.side === "buy" && attractsStampDuty(args.symbol, args.assetClass)
      ? UK_STAMP_DUTY_BPS
      : 0;
  const proportionalBps = 2 * rateBps + spreadBps + stampBps;
  const slackBps = budgetBps - proportionalBps;
  if (slackBps <= 0) return Infinity;

  const floor = estimateSaxoCommission({
    notional: 0,
    symbol: args.symbol,
    assetClass: (args.assetClass ?? "stock") as never,
  }).commission;
  return (2 * floor * 10_000) / slackBps;
}

/**
 * Decide whether a trade is worth routing. Sells of an existing position are
 * held to a looser standard (risk management must always be able to exit), so
 * only BUYs are hard-blocked; sells are flagged but allowed.
 */
export function assessTradeViability(input: ViabilityInput): ViabilityResult {
  const budgetBps = input.budgetBps ?? DEFAULT_ROUND_TRIP_BUDGET_BPS;
  const costs = estimateTradeCosts(input);
  const floor = minViableNotional({
    symbol: input.symbol,
    side: input.side,
    assetClass: input.assetClass,
    spreadBps: input.spreadBps,
    budgetBps,
  });

  if (input.side === "sell") {
    // Never block an exit: stops, trims and de-risking must always execute.
    return { viable: true, budgetBps, costs, minViableNotional: floor };
  }

  if (!(costs.notional > 0)) {
    return {
      viable: false,
      reason: "zero notional",
      budgetBps,
      costs,
      minViableNotional: floor,
    };
  }

  if (costs.roundTripBps > budgetBps) {
    const cur = inferSaxoCurrency(input.symbol);
    return {
      viable: false,
      reason:
        `uneconomic ticket: ${costs.roundTripBps.toFixed(0)}bps round-trip friction ` +
        `on ${cur} ${costs.notional.toFixed(0)} exceeds ${budgetBps}bps budget ` +
        `(commission ${costs.commission.toFixed(2)}` +
        (costs.stampDuty > 0 ? `, stamp duty ${costs.stampDuty.toFixed(2)}` : "") +
        (costs.ptmLevy > 0 ? `, PTM levy ${costs.ptmLevy.toFixed(2)}` : "") +
        `); needs ≥ ${cur} ${Number.isFinite(floor) ? floor.toFixed(0) : "∞"}`,
      budgetBps,
      costs,
      minViableNotional: floor,
    };
  }

  return { viable: true, budgetBps, costs, minViableNotional: floor };
}

/**
 * Modelled per-side cash cost of an executed fill (commission with the venue
 * floor + UK stamp duty on liable buys + PTM levy). Saxo's fill payloads
 * frequently omit commission, which is how ~£180 of friction on a £10k
 * account became invisible in `live_fills.fee` (every row read 0). Booking
 * the modelled number keeps cost attribution and the portfolio cost governor
 * honest; the half-spread is excluded because it is price impact, not a fee.
 */
export function modelledFillFee(args: {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  assetClass?: string | null;
}): number {
  const costs = estimateTradeCosts({ ...args, spreadBps: 0 });
  const fee = costs.commission + costs.stampDuty + costs.ptmLevy;
  return Number.isFinite(fee) && fee > 0 ? Number(fee.toFixed(4)) : 0;
}
