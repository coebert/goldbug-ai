// End-to-end regression suite for a candidate universe that CHANGES MID-TICK.
//
// The engine snapshots `fullUniverse` early in the tick, then does slow work
// (features, news, the AI call) before routing orders. Meanwhile the universe
// itself can move underneath us:
//
//   * a broker suitability block lands and the symbol is filtered out
//     (see `src/lib/broker-instrument-blocks` behaviour),
//   * a name is delisted / renamed and drops out of the refreshed list,
//   * new names appear and prices move, changing what is affordable.
//
// Every one of those must remain a *non-blocking* event for positions we
// already hold: the held-symbol carve-out must survive the swap, and the
// stale-sell fallback must keep working for a symbol that is no longer a
// candidate at all. Otherwise an exit becomes unroutable exactly when we most
// need it — which is the incident class this file locks down.

import { describe, expect, it } from "vitest";
import { aggregateOrders } from "@/lib/order-aggregation";
import {
  planAdmissions,
  governorForNav,
  type GovernorCandidate,
} from "@/lib/cost-governor";
import {
  findStaleWorkingSell,
  type WorkingSellOrder,
} from "@/lib/stale-sell-order";
import { filterUniverseByAffordability } from "@/lib/universe.server";

type Sym = Parameters<typeof filterUniverseByAffordability>[0]["fullUniverse"][number];

function sym(symbol: string, asset_class = "stock"): Sym {
  return { symbol, name: symbol, asset_class } as unknown as Sym;
}

/**
 * Mirrors the engine's contract when the universe is re-read mid-tick:
 * whatever the refreshed list says, every held symbol stays in the candidate
 * set. `filterUniverseByAffordability` can only carve out held names it can
 * still see in `fullUniverse`, so the union has to happen BEFORE the screen.
 */
function resolveTickUniverse(args: {
  refreshed: Sym[];
  /** Universe snapshot taken at the top of the tick. */
  snapshot: Sym[];
  heldSymbols: string[];
}): Sym[] {
  const { refreshed, snapshot, heldSymbols } = args;
  const out = [...refreshed];
  const seen = new Set(refreshed.map((u) => u.symbol));
  const held = new Set(heldSymbols);
  for (const u of snapshot) {
    if (held.has(u.symbol) && !seen.has(u.symbol)) {
      out.push(u);
      seen.add(u.symbol);
    }
  }
  // A holding that never appeared in either list (e.g. transferred in) still
  // has to be exitable, so synthesise a minimal entry for it.
  for (const s of heldSymbols) {
    if (!seen.has(s)) {
      out.push(sym(s));
      seen.add(s);
    }
  }
  return out;
}

const SNAPSHOT: Sym[] = [
  sym("MKS.L"),
  sym("AAPL"),
  sym("SGLN.L", "commodity"),
  sym("VMID.L", "etf"),
];

const PRICES_T0 = new Map<string, number>([
  ["MKS.L", 2],
  ["AAPL", 190],
  ["SGLN.L", 45],
  ["VMID.L", 30],
]);

function screen(universe: Sym[], heldSymbols: string[], prices: Map<string, number>) {
  return filterUniverseByAffordability({
    fullUniverse: universe,
    priceMap: prices,
    heldSymbols,
    cash: 1_000,
    totalValue: 10_300,
    perSymbolCapPct: 0.15,
    minTradeValue: 250,
    currency: "GBP",
  });
}

// ------------------------------------------- held-symbol carve-out survives

describe("held-symbol carve-out across a mid-tick universe swap", () => {
  it("keeps a held name that a broker block removed from the refreshed universe", () => {
    // SGLN.L hit a Saxo suitability rejection mid-tick and was filtered out.
    const refreshed = SNAPSHOT.filter((u) => u.symbol !== "SGLN.L");
    const universe = resolveTickUniverse({
      refreshed,
      snapshot: SNAPSHOT,
      heldSymbols: ["SGLN.L"],
    });
    const symbols = screen(universe, ["SGLN.L"], PRICES_T0).candidates.map((c) => c.symbol);
    // Regression: the holding used to vanish with the universe entry, so the
    // AI never saw it and could never propose the exit.
    expect(symbols).toContain("SGLN.L");
  });

  it("does NOT resurrect a blocked name we do not hold", () => {
    const refreshed = SNAPSHOT.filter((u) => u.symbol !== "SGLN.L");
    const universe = resolveTickUniverse({ refreshed, snapshot: SNAPSHOT, heldSymbols: [] });
    expect(universe.map((u) => u.symbol)).not.toContain("SGLN.L");
    expect(screen(universe, [], PRICES_T0).candidates.map((c) => c.symbol)).not.toContain("SGLN.L");
  });

  it("keeps a holding that is absent from BOTH the snapshot and the refresh", () => {
    const universe = resolveTickUniverse({
      refreshed: SNAPSHOT,
      snapshot: SNAPSHOT,
      heldSymbols: ["BRK-A"],
    });
    expect(universe.map((u) => u.symbol)).toContain("BRK-A");
    // Unpriced and unaffordable, but still a candidate so it can be sold.
    expect(screen(universe, ["BRK-A"], PRICES_T0).candidates.map((c) => c.symbol)).toContain("BRK-A");
  });

  it("never duplicates a held name that the refreshed universe still lists", () => {
    const universe = resolveTickUniverse({
      refreshed: SNAPSHOT,
      snapshot: SNAPSHOT,
      heldSymbols: ["MKS.L", "AAPL"],
    });
    const counts = universe.filter((u) => u.symbol === "MKS.L").length;
    expect(counts).toBe(1);
    const symbols = screen(universe, ["MKS.L", "AAPL"], PRICES_T0).candidates.map((c) => c.symbol);
    expect(symbols.filter((s) => s === "MKS.L")).toHaveLength(1);
  });

  it("admits newly added names from the refresh without losing held ones", () => {
    const refreshed = [...SNAPSHOT.filter((u) => u.symbol !== "MKS.L"), sym("XUKS.L", "etf")];
    const prices = new Map(PRICES_T0).set("XUKS.L", 55);
    const universe = resolveTickUniverse({
      refreshed,
      snapshot: SNAPSHOT,
      heldSymbols: ["MKS.L"],
    });
    const symbols = screen(universe, ["MKS.L"], prices).candidates.map((c) => c.symbol);
    expect(symbols).toContain("XUKS.L");
    expect(symbols).toContain("MKS.L");
  });

  it("keeps a held name whose price gapped above the per-symbol budget mid-tick", () => {
    // Budget = min(10_300 * 0.15, 1_000) = 1_000.
    const prices = new Map(PRICES_T0).set("AAPL", 1_800);
    const universe = resolveTickUniverse({
      refreshed: SNAPSHOT,
      snapshot: SNAPSHOT,
      heldSymbols: ["AAPL"],
    });
    const res = screen(universe, ["AAPL"], prices);
    expect(res.candidates.map((c) => c.symbol)).toContain("AAPL");
    // It is still reported as dropped-for-cash, so buy sizing stays honest.
    expect(res.dropped.map((d) => d.symbol)).toContain("AAPL");
  });

  it("keeps held names even when the refreshed universe is empty", () => {
    const universe = resolveTickUniverse({
      refreshed: [],
      snapshot: SNAPSHOT,
      heldSymbols: ["MKS.L", "SGLN.L"],
    });
    expect(universe.map((u) => u.symbol).sort()).toEqual(["MKS.L", "SGLN.L"]);
    expect(screen(universe, ["MKS.L", "SGLN.L"], PRICES_T0).candidates).toHaveLength(2);
  });

  it("is order-independent: the swap cannot reshuffle a holding out of the cap window", () => {
    const filler = Array.from({ length: 40 }, (_, i) => sym(`F${i}.L`));
    const fillerPrices = new Map(PRICES_T0);
    for (let i = 0; i < 40; i += 1) fillerPrices.set(`F${i}.L`, 10);
    const universe = resolveTickUniverse({
      refreshed: filler,
      snapshot: SNAPSHOT,
      heldSymbols: ["MKS.L"],
    });
    const res = filterUniverseByAffordability({
      fullUniverse: universe,
      priceMap: fillerPrices,
      heldSymbols: ["MKS.L"],
      cash: 1_000,
      totalValue: 10_300,
      perSymbolCapPct: 0.15,
      minTradeValue: 250,
      currency: "GBP",
      maxCandidates: 200,
    });
    expect(res.candidates.map((c) => c.symbol)).toContain("MKS.L");
  });
});

// --------------------------------- stale-sell fallback ignores the universe

type Adapter = {
  listWorkingOrders?: () => Promise<WorkingSellOrder[]>;
  cancelOrder: (id: string) => Promise<{ ok: boolean; reason?: string }>;
};

type StaleSellOutcome =
  | { action: "placed"; cancelledBrokerOrderId: string | null }
  | { action: "skipped"; reason: string };

/** Same pre-flight shape as the live executor's sell path. */
async function runSellPreflight(args: {
  adapter: Adapter;
  symbol: string;
  nowMs: number;
  ledgerOpenSells: number;
}): Promise<StaleSellOutcome> {
  const { adapter, symbol, nowMs } = args;
  if (typeof adapter.listWorkingOrders !== "function") {
    return { action: "placed", cancelledBrokerOrderId: null };
  }
  try {
    const working = await adapter.listWorkingOrders();
    const stale = findStaleWorkingSell({ working, symbol, nowMs });
    if (!stale) return { action: "placed", cancelledBrokerOrderId: null };
    const cancelled = await adapter.cancelOrder(stale.brokerOrderId);
    if (!cancelled.ok) {
      return {
        action: "skipped",
        reason: "stale sell remains open; replacement withheld to prevent duplicate sale",
      };
    }
    return { action: "placed", cancelledBrokerOrderId: stale.brokerOrderId };
  } catch {
    if (args.ledgerOpenSells > 0) {
      return {
        action: "skipped",
        reason: "could not verify stale sell orders and an open sell exists in the ledger",
      };
    }
    return { action: "placed", cancelledBrokerOrderId: null };
  }
}

const T0 = Date.parse("2026-08-21T10:00:00Z");

function workingSell(over: Partial<WorkingSellOrder> = {}): WorkingSellOrder {
  return {
    brokerOrderId: "W1",
    symbol: "SGLN.L:xlon",
    buySell: "Sell",
    filledAmount: 0,
    amount: 40,
    orderTime: new Date(T0 - 20 * 60_000).toISOString(),
    ...over,
  };
}

describe("stale-sell fallback for a symbol dropped mid-tick", () => {
  it("still cancels and replaces the aged sell after the symbol left the universe", async () => {
    const refreshed = SNAPSHOT.filter((u) => u.symbol !== "SGLN.L");
    expect(refreshed.map((u) => u.symbol)).not.toContain("SGLN.L");

    const cancelled: string[] = [];
    const out = await runSellPreflight({
      adapter: {
        listWorkingOrders: async () => [workingSell()],
        cancelOrder: async (id) => {
          cancelled.push(id);
          return { ok: true };
        },
      },
      symbol: "SGLN.L",
      nowMs: T0,
      ledgerOpenSells: 1,
    });
    // Exit plumbing is universe-independent by construction.
    expect(cancelled).toEqual(["W1"]);
    expect(out).toEqual({ action: "placed", cancelledBrokerOrderId: "W1" });
  });

  it("matches the aged sell by venue-suffixed broker symbol after the swap", () => {
    expect(
      findStaleWorkingSell({
        working: [workingSell({ symbol: "SGLN:xlon" })],
        symbol: "SGLN.L",
        nowMs: T0,
      })?.brokerOrderId,
    ).toBe("W1");
  });

  it("does not double-sell when cancellation is unconfirmed during the swap", async () => {
    const out = await runSellPreflight({
      adapter: {
        listWorkingOrders: async () => [workingSell()],
        cancelOrder: async () => ({ ok: false, reason: "429 rate limited" }),
      },
      symbol: "SGLN.L",
      nowMs: T0,
      ledgerOpenSells: 1,
    });
    expect(out.action).toBe("skipped");
  });

  it("still places the exit when the working-order listing fails mid-swap", async () => {
    const out = await runSellPreflight({
      adapter: {
        listWorkingOrders: async () => {
          throw new Error("503 from /trade/v2/orders");
        },
        cancelOrder: async () => ({ ok: true }),
      },
      symbol: "SGLN.L",
      nowMs: T0,
      ledgerOpenSells: 0,
    });
    expect(out.action).toBe("placed");
  });
});

// ----------------------------- routing stays unblocked after the swap

describe("routing a tick whose universe changed underneath it", () => {
  it("nets the exit over a stale buy signal for a now-delisted candidate", () => {
    // The buy was proposed against the pre-swap universe; the sell came from a
    // mechanical stop that fired after the block landed.
    const agg = aggregateOrders([
      { symbol: "SGLN.L", side: "buy", quantity: 20, price: 45, reason: "pre-swap add" },
      { symbol: "SGLN.L", side: "sell", quantity: 40, price: 45, reason: "instrument blocked" },
    ]);
    expect(agg.orders.map((o) => [o.side, o.quantity])).toEqual([["sell", 40]]);
    expect(agg.orders[0]!.reason).toBe("instrument blocked");
  });

  it("admits that exit through the governor with every buy-side gate exhausted", () => {
    const nav = 10_300;
    const candidates: GovernorCandidate[] = [
      { symbol: "SGLN.L", side: "sell", notionalBase: 1_800, estCostBase: 9, isAdd: false },
      { symbol: "AAPL", side: "buy", notionalBase: 1_500, estCostBase: 9, isAdd: true },
    ];
    const plan = planAdmissions(candidates, {
      navBase: nav,
      ...governorForNav(nav),
      buysAlreadyToday: 99,
      trailingCostBase: 10_000,
      lastBuyDaysAgo: { AAPL: 0 },
    });
    const admitted = plan.decisions.filter((d) => d.kind === "admit");
    expect(admitted.map((d) => d.candidate.symbol)).toEqual(["SGLN.L"]);
    expect(plan.decisions.some((d) => d.kind !== "admit" && d.candidate.symbol === "AAPL")).toBe(true);
  });

  it("routes exits for held names that the refreshed screen would have hidden", () => {
    const refreshed = SNAPSHOT.filter((u) => u.symbol !== "SGLN.L");
    const heldSymbols = ["SGLN.L", "MKS.L"];
    const universe = resolveTickUniverse({ refreshed, snapshot: SNAPSHOT, heldSymbols });
    const candidateSymbols = new Set(screen(universe, heldSymbols, PRICES_T0).candidates.map((c) => c.symbol));

    const agg = aggregateOrders(
      heldSymbols.map((s) => ({ symbol: s, side: "sell" as const, quantity: 10, price: 45 })),
    );
    // Every exit we want to route has a live candidate entry behind it, so the
    // AI/prompt layer and the executor agree on the tradable set.
    for (const o of agg.orders) expect(candidateSymbols.has(o.symbol)).toBe(true);
    expect(agg.orders).toHaveLength(2);
  });
});
