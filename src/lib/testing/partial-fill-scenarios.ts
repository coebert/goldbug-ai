// Seeded generator for partial-fill reconciliation scenarios.
//
// The hand-written suites cover the cases we thought of. This generator covers
// the ones we didn't: arbitrary combinations of multiple legs, multiple
// executions per leg, cancel/replace chains, silent cancels, over-fills and
// adverse prints — all reproducible from an integer seed.

import type { ExecutedOrder, IntendedLeg } from "../trade-leg-reconciliation";

export type LegShape =
  | "full_fill" // one order, filled in full
  | "multi_execution" // several fills summing to the intent
  | "partial_short" // marked filled but materially short
  | "over_fill" // executed more than intended
  | "replace_chain" // cancelled with reason, replaced, replacement fills
  | "silent_cancel" // cancelled with no reason at all
  | "rejected_with_reason" // broker said no, and said why
  | "pending_stale" // still working long after the tick
  | "no_order" // never reached the broker
  | "engine_veto" // deliberately suppressed before routing
  | "adverse_print"; // filled in full but far from the intended price

export const ALL_LEG_SHAPES: LegShape[] = [
  "full_fill",
  "multi_execution",
  "partial_short",
  "over_fill",
  "replace_chain",
  "silent_cancel",
  "rejected_with_reason",
  "pending_stale",
  "no_order",
  "engine_veto",
  "adverse_print",
];

export interface GeneratedLeg {
  shape: LegShape;
  leg: IntendedLeg;
  orders: ExecutedOrder[];
  /** Executions that produced `filledQuantity`, kept for assertions. */
  executions: number[];
}

export interface GeneratedScenario {
  seed: number;
  nowMs: number;
  decisionId: string;
  legs: GeneratedLeg[];
  intended: IntendedLeg[];
  orders: ExecutedOrder[];
  /** True when several legs deliberately share one symbol. */
  sharedSymbols: boolean;
}

/** Deterministic PRNG (mulberry32) so a failing seed always reproduces. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: T[]): T {
  return xs[Math.floor(rng() * xs.length) % xs.length]!;
}

function intBetween(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Split `qty` into `n` positive executions that sum exactly to `qty`. */
export function splitExecutions(rng: () => number, qty: number, n: number): number[] {
  if (n <= 1) return [qty];
  const cuts = Array.from({ length: n - 1 }, () => rng())
    .map((r) => Math.max(1, Math.round(r * qty)))
    .sort((a, b) => a - b);
  const parts: number[] = [];
  let prev = 0;
  for (const c of cuts) {
    parts.push(c - prev);
    prev = c;
  }
  parts.push(qty - prev);
  const positive = parts.filter((p) => p > 0);
  const total = positive.reduce((a, b) => a + b, 0);
  if (positive.length === 0) return [qty];
  // Push any rounding residue onto the last slice so the sum is exact.
  positive[positive.length - 1] = positive[positive.length - 1]! + (qty - total);
  return positive;
}

function buildOrders(
  shape: LegShape,
  rng: () => number,
  leg: IntendedLeg,
  ids: { order: () => string; broker: () => string },
  nowMs: number,
): { orders: ExecutedOrder[]; executions: number[] } {
  const price = leg.price ?? 100;
  const createdAt = (agoMin: number) => new Date(nowMs - agoMin * 60_000).toISOString();
  const base = {
    decisionId: leg.decisionId,
    symbol: leg.symbol,
    side: leg.side,
    rejectReason: null as string | null,
    createdAt: createdAt(intBetween(rng, 1, 10)),
  };

  switch (shape) {
    case "full_fill":
    case "adverse_print": {
      const fillPrice =
        shape === "adverse_print"
          ? round2(leg.side === "buy" ? price * 1.05 : price * 0.95)
          : price;
      return {
        orders: [
          {
            ...base,
            id: ids.order(),
            brokerOrderId: ids.broker(),
            quantity: leg.quantity,
            status: "filled",
            filledQuantity: leg.quantity,
            avgFillPrice: fillPrice,
          },
        ],
        executions: [leg.quantity],
      };
    }
    case "multi_execution": {
      const executions = splitExecutions(rng, leg.quantity, intBetween(rng, 2, 4));
      return {
        orders: [
          {
            ...base,
            id: ids.order(),
            brokerOrderId: ids.broker(),
            quantity: leg.quantity,
            status: "filled",
            filledQuantity: executions.reduce((a, b) => a + b, 0),
            avgFillPrice: price,
          },
        ],
        executions,
      };
    }
    case "partial_short": {
      const executed = Math.max(1, Math.round(leg.quantity * (0.1 + rng() * 0.5)));
      return {
        orders: [
          {
            ...base,
            id: ids.order(),
            brokerOrderId: ids.broker(),
            quantity: leg.quantity,
            status: "filled",
            filledQuantity: executed,
            avgFillPrice: price,
          },
        ],
        executions: [executed],
      };
    }
    case "over_fill": {
      const executed = Math.round(leg.quantity * (1.2 + rng() * 0.6));
      return {
        orders: [
          {
            ...base,
            id: ids.order(),
            brokerOrderId: ids.broker(),
            quantity: leg.quantity,
            status: "filled",
            filledQuantity: executed,
            avgFillPrice: price,
          },
        ],
        executions: [executed],
      };
    }
    case "replace_chain": {
      const partial = Math.max(1, Math.round(leg.quantity * (0.2 + rng() * 0.3)));
      const remainder = leg.quantity - partial;
      return {
        orders: [
          {
            ...base,
            id: ids.order(),
            brokerOrderId: ids.broker(),
            quantity: leg.quantity,
            status: "cancelled",
            rejectReason: "replaced: price moved",
            filledQuantity: partial,
            avgFillPrice: price,
            createdAt: createdAt(20),
          },
          {
            ...base,
            id: ids.order(),
            brokerOrderId: ids.broker(),
            quantity: remainder,
            status: "filled",
            filledQuantity: remainder,
            avgFillPrice: price,
            createdAt: createdAt(5),
          },
        ],
        executions: [partial, remainder],
      };
    }
    case "silent_cancel":
      return {
        orders: [
          {
            ...base,
            id: ids.order(),
            brokerOrderId: ids.broker(),
            quantity: leg.quantity,
            status: "cancelled",
            filledQuantity: 0,
            avgFillPrice: null,
          },
        ],
        executions: [],
      };
    case "rejected_with_reason":
      return {
        orders: [
          {
            ...base,
            id: ids.order(),
            brokerOrderId: null,
            quantity: leg.quantity,
            status: "rejected",
            rejectReason: "insufficient funds",
            filledQuantity: 0,
            avgFillPrice: null,
          },
        ],
        executions: [],
      };
    case "pending_stale":
      return {
        orders: [
          {
            ...base,
            id: ids.order(),
            brokerOrderId: ids.broker(),
            quantity: leg.quantity,
            status: "working",
            filledQuantity: 0,
            avgFillPrice: null,
            createdAt: createdAt(120),
          },
        ],
        executions: [],
      };
    case "no_order":
    case "engine_veto":
      return { orders: [], executions: [] };
  }
}

export function generateScenario(
  seed: number,
  opts?: { shapes?: LegShape[]; nowMs?: number; sharedSymbols?: boolean },
): GeneratedScenario {
  const rng = makeRng(seed);
  const nowMs = opts?.nowMs ?? Date.parse("2026-08-21T12:00:00Z");
  const shapes = opts?.shapes ?? ALL_LEG_SHAPES;
  const decisionId = `dec-${seed}`;
  const sharedSymbols = opts?.sharedSymbols ?? rng() < 0.25;

  let orderSeq = 0;
  const ids = {
    order: () => `ord-${seed}-${(orderSeq += 1)}`,
    broker: () => `bro-${seed}-${orderSeq}`,
  };

  const legCount = intBetween(rng, 1, 5);
  const legs: GeneratedLeg[] = [];
  for (let i = 0; i < legCount; i += 1) {
    const shape = pick(rng, shapes);
    const symbol = sharedSymbols ? "SYMX" : `SYM${i}`;
    const leg: IntendedLeg = {
      decisionId,
      symbol,
      side: rng() < 0.5 ? "buy" : "sell",
      quantity: intBetween(rng, 1, 500),
      price: round2(10 + rng() * 300),
      engineRejection: shape === "engine_veto" ? "cost governor: budget spent" : null,
    };
    const { orders, executions } = buildOrders(shape, rng, leg, ids, nowMs);
    legs.push({ shape, leg, orders, executions });
  }

  return {
    seed,
    nowMs,
    decisionId,
    legs,
    sharedSymbols,
    intended: legs.map((l) => l.leg),
    orders: legs.flatMap((l) => l.orders),
  };
}

/** Re-key a scenario with fresh decision/order ids — same reality, new tick. */
export function reissueScenario(s: GeneratedScenario, suffix: string): GeneratedScenario {
  const remapDecision = `${s.decisionId}-${suffix}`;
  const remapOrder = (id: string) => `${id}-${suffix}`;
  const legs = s.legs.map((l) => ({
    ...l,
    leg: { ...l.leg, decisionId: remapDecision },
    orders: l.orders.map((o) => ({
      ...o,
      id: remapOrder(o.id),
      decisionId: remapDecision,
      brokerOrderId: o.brokerOrderId ? remapOrder(o.brokerOrderId) : null,
    })),
  }));
  return {
    ...s,
    decisionId: remapDecision,
    legs,
    intended: legs.map((l) => l.leg),
    orders: legs.flatMap((l) => l.orders),
  };
}
