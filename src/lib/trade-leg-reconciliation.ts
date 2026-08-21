// Automatic per-leg trade reconciliation.
//
// The existing reports answer "how did the last two weeks go?". This module
// answers the operational question, one tick at a time: for the orders the
// engine *intended* this cycle, did each leg reach the broker, and did the
// execution match the intent?
//
// It pairs intended legs with broker orders (decision id first, then
// symbol+side), then classifies every gap:
//
//   dropped_leg      intended, never routed, and no engine veto explains it
//   side_mismatch    routed on the opposite side of the intent
//   quantity_short   materially less quantity routed/filled than intended
//   quantity_over    materially more quantity executed than intended
//   price_deviation  average fill price far from the intended price
//   stale_pending    routed but still non-terminal well past the tick
//   phantom_leg      a broker order with no intended counterpart
//
// Pure functions only: the DB reads and notification writes live in
// `trade-leg-reconciliation.server.ts`.

import { blockSymbolKey } from "./broker-instrument-blocks";

export type LegDiscrepancyCode =
  | "dropped_leg"
  | "side_mismatch"
  | "quantity_short"
  | "quantity_over"
  | "price_deviation"
  | "stale_pending"
  | "phantom_leg";

export type LegSeverity = "critical" | "warning";

export interface IntendedLeg {
  decisionId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number | null;
  /** Engine-side veto text, when the run suppressed the leg before routing. */
  engineRejection: string | null;
}

export interface ExecutedOrder {
  id: string;
  decisionId: string | null;
  symbol: string;
  side: string;
  quantity: number;
  status: string;
  rejectReason: string | null;
  brokerOrderId: string | null;
  createdAt: string;
  /** Aggregated executed quantity across fills. */
  filledQuantity: number;
  /** Quantity-weighted average fill price, when there are fills. */
  avgFillPrice: number | null;
}

export interface LegDiscrepancy {
  code: LegDiscrepancyCode;
  severity: LegSeverity;
  symbol: string;
  symbolKey: string;
  side: "buy" | "sell";
  decisionId: string | null;
  orderId: string | null;
  brokerOrderId: string | null;
  intendedQuantity: number | null;
  executedQuantity: number | null;
  intendedPrice: number | null;
  avgFillPrice: number | null;
  /** Signed deviation in basis points, for `price_deviation`. */
  priceDeviationBps: number | null;
  brokerStatus: string | null;
  detail: string;
  /** Stable identity used to deduplicate repeat notifications. */
  key: string;
}

export interface LegReconSummary {
  intendedLegs: number;
  matchedLegs: number;
  droppedLegs: number;
  mismatchedLegs: number;
  phantomLegs: number;
  /** Notional intended but not executed (uses intended price when known). */
  unexecutedValue: number;
}

export interface LegReconResult {
  discrepancies: LegDiscrepancy[];
  summary: LegReconSummary;
}

export interface LegReconTolerances {
  /** Fractional quantity gap tolerated before flagging (0.02 = 2%). */
  quantityTolerance: number;
  /** Absolute quantity gap always tolerated (rounding / lot sizing). */
  quantityAbsTolerance: number;
  /** Fill-vs-intent price deviation tolerated, in basis points. */
  priceToleranceBps: number;
  /** Age past which a non-terminal order counts as stuck. */
  stalePendingMinutes: number;
}

export const DEFAULT_LEG_TOLERANCES: LegReconTolerances = {
  quantityTolerance: 0.05,
  quantityAbsTolerance: 1e-8,
  priceToleranceBps: 150,
  stalePendingMinutes: 30,
};

const TERMINAL_OK = new Set(["filled"]);
const TERMINAL_DEAD = new Set(["rejected", "cancelled", "canceled", "expired", "error"]);

function normSide(side: string): "buy" | "sell" {
  return String(side).toLowerCase() === "sell" ? "sell" : "buy";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Condition-level identity used to deduplicate *notifications*.
 *
 * `key` is per-decision / per-order, so the same unresolved problem produces a
 * brand-new `key` on every tick (new decision id, new replacement order) and
 * would alert hourly. The alert key instead describes the condition itself —
 * code + symbol + side — plus a coarse magnitude bucket so that a materially
 * worse version of the same problem can still escalate once.
 */
export function discrepancyAlertKey(d: {
  code: LegDiscrepancyCode;
  symbolKey: string;
  side: "buy" | "sell";
  intendedQuantity?: number | null;
  executedQuantity?: number | null;
  priceDeviationBps?: number | null;
}): string {
  const base = `${d.code}|${d.symbolKey}|${d.side}`;
  switch (d.code) {
    case "quantity_short":
    case "quantity_over": {
      const intended = Number(d.intendedQuantity ?? 0);
      const executed = Number(d.executedQuantity ?? 0);
      const gap = intended > 0 ? Math.abs(executed - intended) / intended : 0;
      // 25-point buckets: 5% and 12% short are "the same" alert; 5% and 60% aren't.
      const bucket = Math.min(4, Math.floor(gap * 4));
      return `${base}|g${bucket}`;
    }
    case "price_deviation": {
      const bps = Math.abs(Number(d.priceDeviationBps ?? 0));
      // 100bps buckets, capped so extreme prints collapse together.
      const bucket = Math.min(10, Math.floor(bps / 100));
      return `${base}|d${bucket}`;
    }
    default:
      return base;
  }
}

/** Does this veto text explain, on its own, why nothing was routed? */
export function hasEngineVeto(text: string | null): boolean {
  return typeof text === "string" && text.trim().length > 0;
}

export function reconcileTradeLegs(input: {
  intended: IntendedLeg[];
  orders: ExecutedOrder[];
  nowMs?: number;
  tolerances?: Partial<LegReconTolerances>;
}): LegReconResult {
  const tol = { ...DEFAULT_LEG_TOLERANCES, ...(input.tolerances ?? {}) };
  const now = input.nowMs ?? Date.now();

  // Index orders by symbol root so a broker-native symbol (AAPL:xnas) still
  // pairs with the universe symbol (AAPL) the engine planned with.
  const bySymbol = new Map<string, ExecutedOrder[]>();
  for (const o of input.orders) {
    const k = blockSymbolKey(o.symbol);
    bySymbol.set(k, [...(bySymbol.get(k) ?? []), o]);
  }
  const consumed = new Set<string>();

  const discrepancies: LegDiscrepancy[] = [];
  let matched = 0;
  let dropped = 0;
  let mismatched = 0;
  let unexecutedValue = 0;

  for (const leg of input.intended) {
    const symbolKey = blockSymbolKey(leg.symbol);
    const symbol = leg.symbol.toUpperCase();
    const pool = (bySymbol.get(symbolKey) ?? []).filter((o) => !consumed.has(o.id));
    // Prefer the same decision and the same side; fall back to the opposite
    // side so a genuine side flip surfaces instead of masquerading as a drop.
    const sameSide = pool.filter((o) => normSide(o.side) === leg.side);
    const order =
      sameSide.find((o) => o.decisionId && o.decisionId === leg.decisionId) ??
      sameSide[0] ??
      pool.find((o) => o.decisionId && o.decisionId === leg.decisionId) ??
      pool[0] ??
      null;
    if (order) consumed.add(order.id);

    const base = {
      symbol,
      symbolKey,
      side: leg.side,
      decisionId: leg.decisionId,
      orderId: order?.id ?? null,
      brokerOrderId: order?.brokerOrderId ?? null,
      intendedQuantity: leg.quantity,
      intendedPrice: leg.price,
      brokerStatus: order?.status ?? null,
    };

    if (!order) {
      if (hasEngineVeto(leg.engineRejection)) {
        // Deliberate suppression, not a dropped leg.
        continue;
      }
      dropped += 1;
      unexecutedValue += (leg.price ?? 0) * leg.quantity;
      discrepancies.push({
        ...base,
        code: "dropped_leg",
        severity: "critical",
        executedQuantity: 0,
        avgFillPrice: null,
        priceDeviationBps: null,
        detail:
          `Intended ${leg.side} ${leg.quantity} ${symbol} but no broker order was ` +
          `recorded and the engine logged no veto — the leg was dropped.`,
        key: `dropped_leg|${leg.decisionId}|${symbolKey}|${leg.side}`,
      });
      continue;
    }

    const status = String(order.status ?? "").toLowerCase();
    const executed = Number(order.filledQuantity ?? 0);
    const orderSide = normSide(order.side);
    let flagged = false;

    if (orderSide !== leg.side) {
      flagged = true;
      discrepancies.push({
        ...base,
        code: "side_mismatch",
        severity: "critical",
        executedQuantity: executed,
        avgFillPrice: order.avgFillPrice,
        priceDeviationBps: null,
        detail:
          `Intended ${leg.side} ${symbol} but the broker order is a ${orderSide}.`,
        key: `side_mismatch|${order.id}`,
      });
    }

    const gap = leg.quantity - executed;
    const tolAbs = Math.max(
      tol.quantityAbsTolerance,
      leg.quantity * tol.quantityTolerance,
    );

    if (TERMINAL_DEAD.has(status)) {
      // A stated broker rejection is already reported elsewhere; only flag it
      // here when there is no reason text at all (a silently dropped leg).
      if (!order.rejectReason?.trim()) {
        flagged = true;
        unexecutedValue += (leg.price ?? 0) * Math.max(0, gap);
        discrepancies.push({
          ...base,
          code: "dropped_leg",
          severity: "critical",
          executedQuantity: executed,
          avgFillPrice: order.avgFillPrice,
          priceDeviationBps: null,
          detail:
            `Broker order for ${leg.side} ${leg.quantity} ${symbol} ended "${status}" ` +
            `with no reason recorded; ${executed} of ${leg.quantity} executed.`,
          key: `dropped_leg|${order.id}`,
        });
      }
    } else if (TERMINAL_OK.has(status) && gap > tolAbs) {
      flagged = true;
      unexecutedValue += (leg.price ?? 0) * gap;
      discrepancies.push({
        ...base,
        code: "quantity_short",
        severity: "warning",
        executedQuantity: executed,
        avgFillPrice: order.avgFillPrice,
        priceDeviationBps: null,
        detail:
          `Order marked filled but only ${executed} of ${leg.quantity} ${symbol} executed ` +
          `(${round2((gap / Math.max(leg.quantity, 1e-9)) * 100)}% short).`,
        key: `quantity_short|${order.id}`,
      });
    } else if (!TERMINAL_OK.has(status)) {
      const ageMin = (now - Date.parse(order.createdAt)) / 60_000;
      if (Number.isFinite(ageMin) && ageMin >= tol.stalePendingMinutes) {
        flagged = true;
        unexecutedValue += (leg.price ?? 0) * Math.max(0, gap);
        discrepancies.push({
          ...base,
          code: "stale_pending",
          severity: "warning",
          executedQuantity: executed,
          avgFillPrice: order.avgFillPrice,
          priceDeviationBps: null,
          detail:
            `Order for ${leg.side} ${leg.quantity} ${symbol} is still "${status}" after ` +
            `${Math.round(ageMin)} minutes; ${executed} executed so far.`,
          key: `stale_pending|${order.id}`,
        });
      }
    }

    if (executed - leg.quantity > tolAbs) {
      flagged = true;
      discrepancies.push({
        ...base,
        code: "quantity_over",
        severity: "critical",
        executedQuantity: executed,
        avgFillPrice: order.avgFillPrice,
        priceDeviationBps: null,
        detail:
          `Executed ${executed} ${symbol} against an intended ${leg.quantity} — ` +
          `an over-fill, likely a duplicated leg.`,
        key: `quantity_over|${order.id}`,
      });
    }

    if (leg.price && leg.price > 0 && order.avgFillPrice && order.avgFillPrice > 0) {
      const signed = ((order.avgFillPrice - leg.price) / leg.price) * 10_000;
      // Only adverse deviation matters: paying up on a buy, selling cheap.
      const adverse = leg.side === "buy" ? signed : -signed;
      if (adverse > tol.priceToleranceBps) {
        flagged = true;
        discrepancies.push({
          ...base,
          code: "price_deviation",
          severity: "warning",
          executedQuantity: executed,
          avgFillPrice: order.avgFillPrice,
          priceDeviationBps: round2(signed),
          detail:
            `Filled ${symbol} at ${order.avgFillPrice} against an intended ${leg.price} — ` +
            `${Math.round(adverse)}bps adverse to the intent.`,
          key: `price_deviation|${order.id}`,
        });
      }
    }

    if (flagged) mismatched += 1;
    else matched += 1;
  }

  // Anything routed that no intent claims.
  const phantoms = input.orders.filter((o) => !consumed.has(o.id));
  for (const o of phantoms) {
    const status = String(o.status ?? "").toLowerCase();
    if (TERMINAL_DEAD.has(status)) continue; // dead order, nothing to explain
    discrepancies.push({
      code: "phantom_leg",
      severity: "critical",
      symbol: o.symbol.toUpperCase(),
      symbolKey: blockSymbolKey(o.symbol),
      side: normSide(o.side),
      decisionId: o.decisionId,
      orderId: o.id,
      brokerOrderId: o.brokerOrderId,
      intendedQuantity: null,
      executedQuantity: Number(o.filledQuantity ?? 0),
      intendedPrice: null,
      avgFillPrice: o.avgFillPrice,
      priceDeviationBps: null,
      brokerStatus: o.status ?? null,
      detail:
        `Broker order ${normSide(o.side)} ${o.quantity} ${o.symbol.toUpperCase()} has no ` +
        `matching intended leg in this cycle's decision.`,
      key: `phantom_leg|${o.id}`,
    });
  }

  return {
    discrepancies,
    summary: {
      intendedLegs: input.intended.length,
      matchedLegs: matched,
      droppedLegs: dropped,
      mismatchedLegs: mismatched,
      phantomLegs: phantoms.filter(
        (o) => !TERMINAL_DEAD.has(String(o.status ?? "").toLowerCase()),
      ).length,
      unexecutedValue: round2(unexecutedValue),
    },
  };
}
