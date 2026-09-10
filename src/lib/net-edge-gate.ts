import {
  estimateTradeCosts,
  minViableNotional,
  type TradeCostBreakdown,
} from "./trade-viability-gate";
import {
  minNotionalForMeasuredFloor,
  scaleMeasuredRoundTripBps,
} from "./measured-cost-floor";

/**
 * Net-of-cost edge gate.
 *
 * Every buy carries friction the market has to pay back before the trade makes
 * a penny: Saxo's commission (with its per-side minimum), 0.5% UK stamp duty on
 * liable single shares, the PTM levy, and half the bid/ask spread — twice over,
 * because the position has to be closed again. This module turns that friction
 * into the move the instrument must actually make, and refuses buys whose
 * realistic expected move does not clear it with a margin of safety.
 *
 * Sells are never gated: exits must always be able to fire.
 */

/**
 * Default safety margin: expected move must be 1.25x the round-trip friction.
 *
 * Tuned Sep 2026 by `scripts/run-cost-floor-sweep.ts` (2021-2026 real tape,
 * churn cadence, realistic assumptions). Returns are flat for safety 1.1-1.4
 * and collapse from 1.6 upward (-1.3% at the extreme), so the gate keeps a
 * modest margin rather than the old 1.5x, which sat on the edge of the cliff.
 */
export const DEFAULT_EDGE_SAFETY_MULTIPLE = 1.25;

/**
 * Headroom applied to the account's fill-measured round-trip cost before it is
 * used as a floor.
 *
 * Re-swept 5 Sep 2026 on real closes (2025-09-05 -> 2026-09-05, churn cadence,
 * realistic assumptions, 10-symbol tape). Coarse and fine grids both peak at
 * the same cell: 150bps floor x 1.25 safety -> +7.07% with the lowest drawdown
 * (4.80%) and 47 round trips. 140bps x 1.10 and 170bps x 1.10 are within noise;
 * above ~180bps returns fall away (4.9% at 180 x 1.40, 0.25% at 200 x 2.00).
 * 90bps measured x 1.33 headroom x 1.25 safety = 150bps effective, so the live
 * setting is already the optimum and is left unchanged.
 */
export const MEASURED_FLOOR_HEADROOM = 1.33;


/** Used when a symbol has no ATR reading (conservative daily range). */
export const FALLBACK_ATR_PCT = 0.015;

/** Expected move is clamped into a sane band so one bad ATR can't wave a trade through. */
export const MIN_EXPECTED_MOVE_PCT = 0.005;
export const MAX_EXPECTED_MOVE_PCT = 0.25;

/**
 * Realistic favourable move for a holding period, as a fraction of notional.
 *
 * Daily ATR scales with sqrt(time). Only a fraction of that range is actually
 * captured, and how much depends on conviction: a 0-conviction idea captures a
 * quarter of the move, a 1.0-conviction idea three quarters.
 */
export function expectedMovePct(input: {
  atrPct?: number | null;
  conviction?: number | null;
  horizonDays?: number | null;
}): number {
  const atr =
    Number.isFinite(input.atrPct) && Number(input.atrPct) > 0
      ? Number(input.atrPct)
      : FALLBACK_ATR_PCT;
  const conviction = Number.isFinite(input.conviction)
    ? Math.min(1, Math.max(0, Number(input.conviction)))
    : 0.5;
  const days = Number.isFinite(input.horizonDays) && Number(input.horizonDays) > 0
    ? Number(input.horizonDays)
    : 10;
  const capture = 0.25 + 0.5 * conviction;
  const raw = atr * Math.sqrt(days) * capture;
  return Math.min(MAX_EXPECTED_MOVE_PCT, Math.max(MIN_EXPECTED_MOVE_PCT, raw));
}

export type NetEdgeInput = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  assetClass?: string | null;
  spreadBps?: number;
  /** 0..1 model conviction for this idea. */
  conviction?: number | null;
  /** 14d ATR as a fraction of price. */
  atrPct?: number | null;
  /** Expected holding period in trading days. */
  horizonDays?: number | null;
  /** Expected move must exceed round-trip cost by this factor. */
  safetyMultiple?: number;
  /**
   * The round-trip cost this account actually pays, in bps, measured ticket by
   * ticket from real fills. When supplied, it acts as a FLOOR under the
   * modelled friction: the tariff model routinely under-states what the book
   * really loses to spread and slippage, so a buy must clear the measured
   * figure too.
   */
  measuredRoundTripBps?: number | null;
  /**
   * Notional (instrument currency) the measured figure was sampled at. The
   * measured cost is a ratio dominated by the broker's fixed per-side minimum
   * on small tickets, so it is re-priced at the size actually being routed
   * rather than charged flat. Defaults to the viable-ticket floor.
   */
  measuredAtNotional?: number | null;
};

export type NetEdgeAssessment = {
  pass: boolean;
  reason?: string;
  costs: TradeCostBreakdown;
  /** Expected favourable move as a fraction of notional. */
  expectedMovePct: number;
  /** Same, in bps — directly comparable with `roundTripBps`. */
  expectedMoveBps: number;
  /** Friction the move has to pay back, in bps of notional. */
  roundTripBps: number;
  /** Expected move minus round-trip friction, in bps. Negative = loss-making. */
  netEdgeBps: number;
  /** Cash value of the expected move net of friction, in trade currency. */
  netEdgeValue: number;
  safetyMultiple: number;
  /** Smallest notional whose friction the expected move could clear. */
  minViableNotional: number;
  /** One-line audit note, safe to store on the order row. */
  note: string;
};

export function assessNetEdge(input: NetEdgeInput): NetEdgeAssessment {
  const costs = estimateTradeCosts({
    symbol: input.symbol,
    side: input.side,
    quantity: input.quantity,
    price: input.price,
    assetClass: input.assetClass,
    spreadBps: input.spreadBps,
  });
  const move = expectedMovePct(input);
  const moveBps = move * 10_000;
  const safety = Number.isFinite(input.safetyMultiple) && Number(input.safetyMultiple) > 0
    ? Number(input.safetyMultiple)
    : DEFAULT_EDGE_SAFETY_MULTIPLE;
  const modelledRoundTripBps = Number.isFinite(costs.roundTripBps) ? costs.roundTripBps : Infinity;
  const measuredRaw =
    Number.isFinite(input.measuredRoundTripBps) && Number(input.measuredRoundTripBps) > 0
      ? Number(input.measuredRoundTripBps) * MEASURED_FLOOR_HEADROOM
      : 0;
  const measuredAtNotional =
    Number.isFinite(input.measuredAtNotional) && Number(input.measuredAtNotional) > 0
      ? Number(input.measuredAtNotional)
      : undefined;
  // Re-price the measured floor at THIS ticket's size: its fixed commission
  // component is pounds, not bps, so a bigger ticket genuinely pays less.
  const measuredFloor = measuredRaw
    ? scaleMeasuredRoundTripBps({
        symbol: input.symbol,
        assetClass: input.assetClass,
        measuredRoundTripBps: measuredRaw,
        measuredAtNotional,
        notional: costs.notional,
      })
    : 0;
  const roundTripBps = Math.max(modelledRoundTripBps, measuredFloor);
  const netEdgeBps = moveBps - roundTripBps;
  const netEdgeValue = (netEdgeBps / 10_000) * costs.notional;

  // The break-even budget the ticket must fit: the expected move divided by the
  // safety multiple. A trade sized so its friction eats that is not an edge.
  const budgetBps = moveBps / safety;
  const modelFloor = minViableNotional({
    symbol: input.symbol,
    side: input.side,
    assetClass: input.assetClass,
    spreadBps: input.spreadBps,
    budgetBps,
  });
  // The size-up target has to clear the measured floor too, or the retry lands
  // on a ticket the gate rejects for the same reason it rejected the first.
  const measuredFloorNotional = measuredRaw
    ? minNotionalForMeasuredFloor({
        symbol: input.symbol,
        assetClass: input.assetClass,
        measuredRoundTripBps: measuredRaw,
        measuredAtNotional,
        budgetBps,
      })
    : 0;
  const floor = Math.max(modelFloor, measuredFloorNotional);

  const stampNote = costs.stampDuty > 0 ? `, stamp ${costs.stampDutyBps.toFixed(0)}bps` : "";
  const note =
    `net edge ${netEdgeBps.toFixed(0)}bps ` +
    `(expected move ${moveBps.toFixed(0)}bps vs round-trip ${Number.isFinite(roundTripBps) ? roundTripBps.toFixed(0) : "∞"}bps: ` +
    `commission ${costs.commissionBps.toFixed(0)}bps${stampNote}, spread ${costs.halfSpreadBps.toFixed(0)}bps/side` +
    (measuredFloor > modelledRoundTripBps
      ? `; measured account cost floor ${measuredFloor.toFixed(0)}bps applied`
      : "") +
    `)`;

  const base = {
    costs,
    expectedMovePct: move,
    expectedMoveBps: moveBps,
    roundTripBps,
    netEdgeBps,
    netEdgeValue,
    safetyMultiple: safety,
    minViableNotional: floor,
    note,
  };

  // Exits are never blocked on cost grounds.
  if (input.side === "sell") return { pass: true, ...base };

  if (!(costs.notional > 0)) {
    return { pass: false, reason: "zero notional", ...base };
  }

  if (moveBps < roundTripBps * safety) {
    return {
      pass: false,
      reason:
        `costs exceed edge: needs ${(roundTripBps * safety).toFixed(0)}bps of expected move ` +
        `(${roundTripBps.toFixed(0)}bps round-trip × ${safety.toFixed(2)} safety) but the ` +
        `signal only supports ${moveBps.toFixed(0)}bps` +
        (costs.stampDuty > 0
          ? ` — ${costs.stampDutyBps.toFixed(0)}bps of that is UK stamp duty, so a stamp-exempt ETF would need less`
          : "") +
        (Number.isFinite(floor) ? `; needs ≥ ${floor.toFixed(0)} notional` : ""),
      ...base,
    };
  }

  return { pass: true, ...base };
}
