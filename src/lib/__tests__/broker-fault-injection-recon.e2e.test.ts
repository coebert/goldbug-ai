// End-to-end: broker faults → reconciliation stays consistent.
//
// The fault-injecting simulator (`src/lib/brokers/fault-injection-sim.ts`)
// misbehaves the way Saxo has misbehaved in production: it times out after
// accepting an order, acknowledges the same client order id twice, and
// occasionally acks a leg it never books. These tests drive real order flow
// through it and then reconcile the intents against the broker's OWN book with
// `reconcileTradeLegs` — never against what `placeOrder` returned.
//
// The property under test is a single sentence: whatever the broker does, the
// reconciliation output must describe reality — no silent drops, no
// double-counted fills, and no clean bill of health while inventory is
// stranded.

import { describe, expect, it } from "vitest";
import {
  BrokerTimeoutError,
  FaultInjectingBroker,
  type FaultRule,
} from "@/lib/brokers/fault-injection-sim";
import {
  reconcileTradeLegs,
  DEFAULT_LEG_TOLERANCES,
  type IntendedLeg,
} from "@/lib/trade-leg-reconciliation";

const T0 = Date.parse("2026-08-21T10:00:00Z");
const MIN = 60_000;
const PRICES = { "MKS.L": 200, "VMID.L": 30, "AAPL:xnas": 230 };

function broker(faults: FaultRule[] = [], seed = 7) {
  return new FaultInjectingBroker({
    faults,
    seed,
    prices: PRICES,
    startedAtMs: T0,
    startingCash: 250_000,
  });
}

function intent(
  symbol: string,
  side: "buy" | "sell",
  quantity: number,
  clientOrderId: string,
): IntendedLeg {
  return {
    decisionId: clientOrderId,
    symbol,
    side,
    quantity,
    price: PRICES[symbol as keyof typeof PRICES] ?? 100,
    engineRejection: null,
  };
}

function req(leg: IntendedLeg) {
  return {
    symbol: leg.symbol,
    side: leg.side,
    quantity: leg.quantity,
    orderType: "market" as const,
    clientOrderId: leg.decisionId,
  };
}

/** Place a leg, swallowing a timeout the way the executor's retry loop does. */
async function placeTolerant(sim: FaultInjectingBroker, leg: IntendedLeg) {
  try {
    return { ok: true as const, result: await sim.placeOrder(req(leg)) };
  } catch (err) {
    if (err instanceof BrokerTimeoutError) return { ok: false as const, err };
    throw err;
  }
}

// ------------------------------------------------------------------ timeouts

describe("fault injection: timeouts", () => {
  it("throws a typed timeout while still booking the order broker-side", async () => {
    const sim = broker([{ kind: "timeout", symbol: "MKS.L" }]);
    const leg = intent("MKS.L", "buy", 100, "dec-1");

    await expect(sim.placeOrder(req(leg))).rejects.toBeInstanceOf(BrokerTimeoutError);
    // The response was lost, not the order — this is the trap.
    expect(sim.book).toHaveLength(1);
    expect(sim.book[0]!.filledQuantity).toBe(100);
  });

  it("a retry after a timeout is idempotent — no double trade", async () => {
    const sim = broker([{ kind: "timeout", symbol: "MKS.L" }]);
    const leg = intent("MKS.L", "buy", 100, "dec-1");

    const first = await placeTolerant(sim, leg);
    expect(first.ok).toBe(false);
    const retry = await placeTolerant(sim, leg);
    expect(retry.ok).toBe(true);

    expect(sim.attempts).toHaveLength(2);
    expect(sim.book).toHaveLength(1);
    expect(sim.netExecuted()["MKS.L"]).toBe(100);

    // And reconciliation sees exactly one clean leg.
    const res = reconcileTradeLegs({
      intended: [leg],
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies).toEqual([]);
    expect(res.summary.matchedLegs).toBe(1);
  });

  it("a timeout that never reached the broker reconciles as a dropped leg", async () => {
    const sim = broker([{ kind: "timeout", symbol: "MKS.L", timeoutDropsOrder: true }]);
    const leg = intent("MKS.L", "sell", 500, "dec-1");

    const attempt = await placeTolerant(sim, leg);
    expect(attempt.ok).toBe(false);
    expect(sim.book).toHaveLength(0);

    const res = reconcileTradeLegs({
      intended: [leg],
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies.map((d) => d.code)).toEqual(["dropped_leg"]);
    expect(res.discrepancies[0]!.severity).toBe("critical");
    // 500 shares still held — the exit did not happen.
    expect(res.summary.unexecutedValue).toBe(500 * 200);
  });

  it("a timeout on one leg never hides the healthy legs around it", async () => {
    const sim = broker([{ kind: "timeout", symbol: "VMID.L", timeoutDropsOrder: true }]);
    const legs = [
      intent("MKS.L", "sell", 100, "dec-1"),
      intent("VMID.L", "sell", 50, "dec-2"),
      intent("AAPL:xnas", "buy", 10, "dec-3"),
    ];
    for (const l of legs) await placeTolerant(sim, l);

    const res = reconcileTradeLegs({
      intended: legs,
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(res.summary.matchedLegs).toBe(2);
    expect(res.summary.droppedLegs).toBe(1);
    expect(res.discrepancies.map((d) => d.symbol)).toEqual(["VMID.L"]);
  });
});

// -------------------------------------------------------- duplicate acks

describe("fault injection: duplicate acknowledgements", () => {
  it("an idempotent duplicate ack returns the same broker order id and books once", async () => {
    const sim = broker([{ kind: "duplicate_ack", symbol: "MKS.L" }]);
    const leg = intent("MKS.L", "buy", 100, "dec-1");

    const a = await sim.placeOrder(req(leg));
    const b = await sim.placeOrder(req(leg));
    expect(b.brokerOrderId).toBe(a.brokerOrderId);
    expect(sim.book).toHaveLength(1);

    const res = reconcileTradeLegs({
      intended: [leg],
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies).toEqual([]);
  });

  it("a broker that books the duplicate surfaces as over-fill plus phantom leg", async () => {
    const sim = broker([{ kind: "duplicate_ack", symbol: "MKS.L", duplicateBooks: true }]);
    const leg = intent("MKS.L", "buy", 100, "dec-1");

    await sim.placeOrder(req(leg));
    const dup = await sim.placeOrder(req(leg));
    expect(sim.book).toHaveLength(2);
    expect(dup.brokerOrderId).not.toBe(sim.book[0]!.brokerOrderId);
    // Reality: we bought 200 against an intended 100.
    expect(sim.netExecuted()["MKS.L"]).toBe(200);

    const res = reconcileTradeLegs({
      intended: [leg],
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    // One intent can only claim one order; the second is unexplained.
    const codes = res.discrepancies.map((d) => d.code).sort();
    expect(codes).toEqual(["phantom_leg"]);
    expect(res.summary.phantomLegs).toBe(1);
    const phantom = res.discrepancies[0]!;
    expect(phantom.severity).toBe("critical");
    expect(phantom.executedQuantity).toBe(100);
  });

  it("a duplicate book on one symbol does not perturb other symbols", async () => {
    const sim = broker([{ kind: "duplicate_ack", symbol: "MKS.L", duplicateBooks: true }]);
    const legs = [intent("MKS.L", "buy", 100, "dec-1"), intent("VMID.L", "buy", 50, "dec-2")];
    for (const l of legs) await sim.placeOrder(req(l));
    await sim.placeOrder(req(legs[0]!)); // the duplicate ack

    const res = reconcileTradeLegs({
      intended: legs,
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(res.summary.matchedLegs).toBe(2);
    expect(res.summary.phantomLegs).toBe(1);
    expect(res.discrepancies.every((d) => d.symbol === "MKS.L")).toBe(true);
  });
});

// ------------------------------------------------------------ missing legs

describe("fault injection: missing legs", () => {
  it("a healthy ack with nothing booked reconciles as a critical dropped leg", async () => {
    const sim = broker([{ kind: "missing_leg", symbol: "MKS.L" }]);
    const leg = intent("MKS.L", "sell", 1_000, "dec-1");

    const ack = await sim.placeOrder(req(leg));
    // The client-side view looks fine — this is exactly why we never trust it.
    expect(ack.status).toBe("submitted");
    expect(ack.brokerOrderId).toContain("GHOST");
    expect(sim.book).toHaveLength(0);

    const res = reconcileTradeLegs({
      intended: [leg],
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies.map((d) => d.code)).toEqual(["dropped_leg"]);
    expect(res.summary.unexecutedValue).toBe(1_000 * 200);
    expect(res.summary.matchedLegs).toBe(0);
  });

  it("an engine-vetoed leg is not reported as a dropped leg", async () => {
    const sim = broker();
    const vetoed: IntendedLeg = {
      ...intent("VMID.L", "buy", 50, "dec-2"),
      engineRejection: "cost governor: friction budget exhausted",
    };
    const res = reconcileTradeLegs({
      intended: [vetoed],
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    // Nothing routed, but the run explained why — that is not an incident.
    expect(res.discrepancies).toEqual([]);
    expect(res.summary.droppedLegs).toBe(0);
  });

  it("an explicit reasoned rejection is not double-reported as a drop", async () => {
    const sim = broker([{ kind: "reject", symbol: "MKS.L", reason: "Not enough funds" }]);
    const leg = intent("MKS.L", "buy", 1_000, "dec-1");
    const out = await sim.placeOrder(req(leg));
    expect(out.status).toBe("rejected");

    const res = reconcileTradeLegs({
      intended: [leg],
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies).toEqual([]);
    expect(res.summary.matchedLegs).toBe(1);
  });

  it("a silent rejection with no reason IS reported as a dropped leg", async () => {
    const sim = broker([{ kind: "reject", symbol: "MKS.L", reason: "" }]);
    const leg = intent("MKS.L", "buy", 1_000, "dec-1");
    await sim.placeOrder(req(leg));

    const res = reconcileTradeLegs({
      intended: [leg],
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies.map((d) => d.code)).toEqual(["dropped_leg"]);
  });
});

// -------------------------------------------- partials and adverse prints

describe("fault injection: partial fills and adverse prints", () => {
  it("a partial fill reports the shortfall and the stranded notional", async () => {
    const sim = broker([{ kind: "partial_fill", symbol: "MKS.L", fillFraction: 0.38 }]);
    const leg = intent("MKS.L", "sell", 1_000, "dec-1");
    const out = await sim.placeOrder(req(leg));
    expect(out.filledQuantity).toBe(380);

    const res = reconcileTradeLegs({
      intended: [leg],
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies.map((d) => d.code)).toEqual(["quantity_short"]);
    expect(res.summary.unexecutedValue).toBe(620 * 200);
  });

  it("a zero-fill working order becomes stale_pending once it ages out", async () => {
    const sim = broker([{ kind: "partial_fill", symbol: "MKS.L", fillFraction: 0 }]);
    const leg = intent("MKS.L", "sell", 1_000, "dec-1");
    await sim.placeOrder(req(leg));
    const orders = sim.toExecutedOrders();

    expect(
      reconcileTradeLegs({ intended: [leg], orders, nowMs: T0 + 5 * MIN }).discrepancies,
    ).toEqual([]);
    const aged = reconcileTradeLegs({
      intended: [leg],
      orders,
      nowMs: T0 + (DEFAULT_LEG_TOLERANCES.stalePendingMinutes + 2) * MIN,
    });
    expect(aged.discrepancies.map((d) => d.code)).toEqual(["stale_pending"]);
  });

  it("an adverse print is flagged without masking the rest of the cycle", async () => {
    const sim = broker([{ kind: "adverse_price", symbol: "MKS.L", adverseBps: 300 }]);
    const legs = [intent("MKS.L", "sell", 100, "dec-1"), intent("VMID.L", "sell", 50, "dec-2")];
    for (const l of legs) await sim.placeOrder(req(l));

    const res = reconcileTradeLegs({
      intended: legs,
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(res.discrepancies.map((d) => d.code)).toEqual(["price_deviation"]);
    expect(res.discrepancies[0]!.priceDeviationBps).toBeCloseTo(-300, 6);
    expect(res.summary.matchedLegs).toBe(1); // VMID.L stayed clean
  });
});

// ------------------------------------------------- combined fault storms

describe("fault injection: combined storms stay reconcilable", () => {
  const storm: FaultRule[] = [
    { kind: "timeout", symbol: "MKS.L" },
    { kind: "missing_leg", symbol: "VMID.L" },
    { kind: "partial_fill", symbol: "AAPL:xnas", fillFraction: 0.5 },
  ];

  it("classifies every fault in one cycle without cross-contamination", async () => {
    const sim = broker(storm);
    const legs = [
      intent("MKS.L", "buy", 100, "dec-1"),
      intent("VMID.L", "sell", 50, "dec-2"),
      intent("AAPL:xnas", "buy", 10, "dec-3"),
    ];
    for (const l of legs) await placeTolerant(sim, l);

    const res = reconcileTradeLegs({
      intended: legs,
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    const bySymbol = Object.fromEntries(res.discrepancies.map((d) => [d.symbol, d.code]));
    // MKS.L timed out but was booked → clean once we read the broker's book.
    expect(bySymbol["MKS.L"]).toBeUndefined();
    expect(bySymbol["VMID.L"]).toBe("dropped_leg");
    expect(bySymbol["AAPL:XNAS"]).toBe("quantity_short");
    expect(res.summary.intendedLegs).toBe(3);
    expect(res.summary.matchedLegs + res.summary.mismatchedLegs + res.summary.droppedLegs).toBe(3);
    expect(res.summary.phantomLegs).toBe(0);
  });

  it("is deterministic — identical seeds and scripts give identical discrepancies", async () => {
    const run = async () => {
      const sim = broker(storm, 42);
      const legs = [
        intent("MKS.L", "buy", 100, "dec-1"),
        intent("VMID.L", "sell", 50, "dec-2"),
        intent("AAPL:xnas", "buy", 10, "dec-3"),
      ];
      for (const l of legs) await placeTolerant(sim, l);
      return reconcileTradeLegs({
        intended: legs,
        orders: sim.toExecutedOrders(),
        nowMs: T0 + MIN,
      });
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
  });

  it("recon after remediation is clean and the net position matches intent", async () => {
    const sim = broker([
      { kind: "timeout", symbol: "MKS.L", timeoutDropsOrder: true },
      { kind: "partial_fill", symbol: "AAPL:xnas", fillFraction: 0.5 },
    ]);
    const dropped = intent("MKS.L", "sell", 100, "dec-1");
    const partial = intent("AAPL:xnas", "buy", 10, "dec-2");
    await placeTolerant(sim, dropped);
    await placeTolerant(sim, partial);

    const first = reconcileTradeLegs({
      intended: [dropped, partial],
      orders: sim.toExecutedOrders(),
      nowMs: T0 + MIN,
    });
    expect(first.discrepancies.map((d) => d.code).sort()).toEqual([
      "dropped_leg",
      "quantity_short",
    ]);

    // Remediation tick: re-issue the dropped leg and the 5-share residual.
    const retryDropped = intent("MKS.L", "sell", 100, "dec-1-retry");
    const retryResidual = intent("AAPL:xnas", "buy", 5, "dec-2-retry");
    await sim.placeOrder(req(retryDropped));
    await sim.placeOrder(req(retryResidual));

    const second = reconcileTradeLegs({
      intended: [retryDropped, retryResidual],
      orders: sim
        .toExecutedOrders()
        .filter((o) => o.decisionId === "dec-1-retry" || o.decisionId === "dec-2-retry"),
      nowMs: T0 + 20 * MIN,
    });
    expect(second.discrepancies).toEqual([]);
    expect(second.summary.unexecutedValue).toBe(0);

    const net = sim.netExecuted();
    expect(net["MKS.L"]).toBe(-100);
    expect(net["AAPL:xnas"]).toBe(10);
  });

  it("total executed quantity never exceeds intent unless a duplicate was booked", async () => {
    const clean = broker(storm);
    const legs = [
      intent("MKS.L", "buy", 100, "dec-1"),
      intent("VMID.L", "sell", 50, "dec-2"),
      intent("AAPL:xnas", "buy", 10, "dec-3"),
    ];
    for (const l of legs) await placeTolerant(clean, l);
    for (const [symbol, qty] of Object.entries(clean.netExecuted())) {
      const intended = legs.find((l) => l.symbol === symbol)!;
      expect(Math.abs(qty)).toBeLessThanOrEqual(intended.quantity);
    }
  });
});
