/**
 * Next-best-trade ranking for the Portfolio page.
 *
 * Answers one plain question: of the names this book already owns, which one
 * is worth adding to next, at what price, for what dealing cost, and what
 * profit does the expected move leave after that cost is paid?
 *
 * The ranking deliberately reuses the live money rules rather than inventing
 * a second opinion:
 *   * `assessNetEdge` prices the FULL round trip (commission + stamp + levy +
 *     half-spread both ways) against the move the signal actually supports,
 *     with the account's measured cost floor underneath it.
 *   * `planViableSizeUp` lifts an undersized ticket to the fee-viable notional
 *     when cash and the position cap allow, exactly as the executor does.
 *   * `positionCapPctFor` applies the wider cap to broad diversified funds.
 *
 * Pure module: no database, no network. The server function feeds it prices,
 * indicators and cash; every number it returns is reproducible from its input.
 */

import { assessNetEdge } from "./net-edge-gate";
import { planViableSizeUp } from "./viable-size-up";
import { positionCapPctFor, DEFAULT_MAX_DIVERSIFIED_POSITION_PCT_OF_NAV } from "./diversified-fund";
import { DEFAULT_MAX_POSITION_PCT_OF_NAV } from "./cost-governor";

export type NextBuyCandidate = {
  symbol: string;
  name?: string | null;
  assetClass?: string | null;
  /** Per-share price in the instrument's own currency. */
  price: number;
  currency: string;
  /** Multiply an amount in the instrument's currency to get portfolio currency. */
  fxToBase: number;
  atrPct?: number | null;
  rsi14?: number | null;
  change5d?: number | null;
  change30d?: number | null;
  macdHist?: number | null;
  sma20?: number | null;
  sma50?: number | null;
  sma200?: number | null;
  weeklyTrendUp?: boolean | null;
  /** Shares already held. */
  heldQuantity: number;
  /** Value of the existing position in portfolio currency. */
  heldValueBase: number;
  diversified?: boolean;
  /** This name's own measured round-trip cost in bps, when the book has dealt it. */
  measuredRoundTripBps?: number | null;
};

export type NextBuyInput = {
  candidates: NextBuyCandidate[];
  /** Account value in portfolio currency. */
  navBase: number;
  /** Free cash in portfolio currency. */
  cashBase: number;
  /** Governor's smallest fee-viable ticket in portfolio currency. */
  minTicketBase: number;
  /** Ordinary single-name position cap as a fraction of NAV. */
  maxPositionPctOfNav?: number;
  /** Wider cap for broad diversified trackers. */
  maxDiversifiedPositionPctOfNav?: number;
  /** Cost hurdle: expected move must beat friction by this multiple. */
  safetyMultiple?: number;
  /** Account-wide measured round trip in bps, used when a name has no own figure. */
  measuredRoundTripBps?: number | null;
  /** Expected holding period in trading days. */
  horizonDays?: number;
  /** Share of NAV a fresh add aims at before caps and cash bite. */
  targetWeightPct?: number;
  /**
   * Cash the account must keep back (settlement, fees, the executor's safety
   * buffer). Suggestions are sized out of cash ABOVE this, never through it.
   */
  cashReserveBase?: number;
  /** Most of the spare cash one suggestion may consume (0-1). */
  maxCashSharePct?: number;
};

export type NextBuyRow = {
  symbol: string;
  name: string | null;
  currency: string;
  /** 0..1 strength of the trend/momentum read behind the add. */
  conviction: number;
  /** Plain-language reasons behind the conviction score. */
  signals: string[];
  /** Latest price in the instrument's own currency. */
  price: number;
  /** Shares to buy. */
  quantity: number;
  /** Ticket value in portfolio currency. */
  ticketBase: number;
  /** Round-trip dealing cost in portfolio currency. */
  costBase: number;
  /** Expected move minus that cost, in portfolio currency. */
  expectedProfitBase: number;
  expectedMoveBps: number;
  roundTripBps: number;
  netEdgeBps: number;
  heldQuantity: number;
  /** True when this add clears the live cost gate today. */
  recommended: boolean;
  /** Why it does not clear the gate, when it doesn't. */
  blockedReason: string | null;
  sizedUp: boolean;
};

export const DEFAULT_TARGET_WEIGHT_PCT = 0.12;
export const DEFAULT_HORIZON_DAYS = 10;
/** Most of the spare cash a single suggestion may take by default. */
export const DEFAULT_MAX_CASH_SHARE_PCT = 0.6;

/**
 * Cash the executor keeps back: 2% of NAV plus a flat settlement buffer.
 * Same shape as `trading-engine.server.ts` uses when it sizes a core top-up,
 * so the panel can never suggest money the live path would refuse to spend.
 */
export function cashReserveForNav(navBase: number): number {
  return Math.max(0, navBase * 0.02) + 250;
}

/**
 * Trend and momentum read for one name, expressed as 0..1 conviction plus the
 * reasons behind it. Deliberately simple and legible: the panel has to be able
 * to say why in words the account holder can check against the chart.
 */
export function scoreConviction(c: NextBuyCandidate): { conviction: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0.05;
  const add = (weight: number, label: string) => {
    score += weight;
    signals.push(label);
  };

  if (c.sma20 != null && c.price > c.sma20) add(0.15, "price above its 20-day average");
  if (c.sma20 != null && c.sma50 != null && c.sma20 > c.sma50) add(0.15, "20-day above 50-day average");
  if (c.sma200 != null && c.price > c.sma200) add(0.1, "above the 200-day trend line");
  if (c.weeklyTrendUp === true) add(0.1, "weekly trend still rising");
  if (c.macdHist != null && c.macdHist > 0) add(0.1, "momentum turning up");
  if (c.change5d != null && c.change5d > 0) add(0.1, "up over the last week");
  if (c.change30d != null && c.change30d > 0) add(0.1, "up over the last month");

  if (c.rsi14 != null) {
    if (c.rsi14 >= 75) {
      score -= 0.15;
      signals.push("looks stretched after a fast run");
    } else if (c.rsi14 <= 30) {
      add(0.1, "heavily sold off");
    } else if (c.rsi14 >= 45 && c.rsi14 <= 65) {
      add(0.05, "steady, not overbought");
    }
  }

  return { conviction: Math.min(1, Math.max(0, score)), signals };
}

function toRow(
  c: NextBuyCandidate,
  input: NextBuyInput,
): NextBuyRow | null {
  const fx = Number.isFinite(c.fxToBase) && c.fxToBase > 0 ? c.fxToBase : 1;
  if (!(c.price > 0) || !(fx > 0)) return null;

  const { conviction, signals } = scoreConviction(c);
  const priceBase = c.price * fx;

  const capPct = positionCapPctFor(
    c.diversified,
    input.maxPositionPctOfNav ?? DEFAULT_MAX_POSITION_PCT_OF_NAV,
    input.maxDiversifiedPositionPctOfNav ?? DEFAULT_MAX_DIVERSIFIED_POSITION_PCT_OF_NAV,
  );
  const capRoomBase = Math.max(0, input.navBase * capPct - c.heldValueBase);

  // Money this account can actually put to work today: free cash less the
  // reserve the live path keeps back, and no more than one suggestion's share
  // of it, so a single idea never drains the book.
  const reserveBase = input.cashReserveBase ?? cashReserveForNav(input.navBase);
  const freeCashBase = Math.max(0, input.cashBase - reserveBase);
  const shareCap = Math.min(1, Math.max(0.1, input.maxCashSharePct ?? DEFAULT_MAX_CASH_SHARE_PCT));
  // One idea may still take the whole free balance when that is the only way
  // to reach a fee-viable ticket — the alternative is an over-priced stub.
  const cashForTicketBase = Math.max(
    Math.min(freeCashBase, input.minTicketBase),
    freeCashBase * shareCap,
  );

  const targetBase = Math.max(
    input.minTicketBase,
    input.navBase * (input.targetWeightPct ?? DEFAULT_TARGET_WEIGHT_PCT),
  );
  const spendableBase = Math.max(0, Math.min(cashForTicketBase, capRoomBase));
  const ticketBase = Math.min(targetBase, spendableBase);

  // Under the minimum viable ticket the dealing costs eat the idea; say so in
  // money terms instead of quietly suggesting a stub trade.
  const cashShort = ticketBase < input.minTicketBase - 0.01;

  let quantity = Math.floor(ticketBase / priceBase);
  if (quantity < 1) {
    // The position cap leaves no room at all — there is nothing to say.
    if (capRoomBase < priceBase) return null;
    // Cash is the binding constraint: keep the idea visible and priced at one
    // share, so the panel can explain the shortfall in money terms.
    quantity = 1;
  }

  const gateInput = {
    symbol: c.symbol,
    side: "buy" as const,
    price: c.price,
    assetClass: c.assetClass,
    conviction,
    atrPct: c.atrPct ?? null,
    horizonDays: input.horizonDays ?? DEFAULT_HORIZON_DAYS,
    safetyMultiple: input.safetyMultiple,
    measuredRoundTripBps:
      c.measuredRoundTripBps && c.measuredRoundTripBps > 0
        ? c.measuredRoundTripBps
        : input.measuredRoundTripBps ?? null,
  };

  let edge = assessNetEdge({ ...gateInput, quantity });
  let sizedUp = false;

  // Same fix the executor applies: a ticket that fails only because it is too
  // small to carry its fixed costs is a sizing mistake, not a bad idea.
  if (!edge.pass && Number.isFinite(edge.minViableNotional)) {
    const plan = planViableSizeUp({
      quantity,
      price: c.price,
      minViableNotional: edge.minViableNotional,
      spendable: spendableBase / fx,
      maxNotional: capRoomBase / fx,
    });
    if (plan.applied) {
      const retry = assessNetEdge({ ...gateInput, quantity: plan.quantity });
      if (retry.pass) {
        quantity = plan.quantity;
        edge = retry;
        sizedUp = true;
      }
    }
  }

  const notionalBase = quantity * priceBase;
  const costBase = (edge.roundTripBps / 10_000) * notionalBase;

  return {
    symbol: c.symbol,
    name: c.name ?? null,
    currency: c.currency,
    conviction,
    signals,
    price: c.price,
    quantity,
    ticketBase: notionalBase,
    costBase,
    expectedProfitBase: (edge.netEdgeBps / 10_000) * notionalBase,
    expectedMoveBps: edge.expectedMoveBps,
    roundTripBps: edge.roundTripBps,
    netEdgeBps: edge.netEdgeBps,
    heldQuantity: c.heldQuantity,
    recommended: edge.pass && !cashBlocked,
    blockedReason: cashBlocked
      ? `not enough spare cash: ${Math.round(freeCashBase)} free after the reserve, ` +
        `smallest worthwhile buy is ${Math.round(input.minTicketBase)}`
      : edge.pass
        ? null
        : edge.reason ?? "does not clear the cost floor",
    sizedUp,
  };
}

/**
 * Rank the account's holdings by the money an add is expected to make after
 * this account's real dealing costs. Best first; ideas that fail the live cost
 * gate are still returned (behind the passing ones) so the panel can explain
 * why nothing is worth buying when that is the honest answer.
 */
export function rankNextBuys(input: NextBuyInput): NextBuyRow[] {
  const rows: NextBuyRow[] = [];
  for (const c of input.candidates) {
    if (!(c.heldQuantity > 0)) continue;
    const row = toRow(c, input);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    return b.expectedProfitBase - a.expectedProfitBase;
  });
}
