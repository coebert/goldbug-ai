// End-to-end routing regression suite for the three guards that have
// historically blocked legitimate trades — especially exits.
//
// It composes the same modules the live executor runs
// (`src/lib/live-executor.server.ts`), without Supabase or the Saxo HTTP
// client:
//
//   1. aggregateOrders             → intent-level ticket netting (pre-place)
//   2. planAdmissions              → cost-governor admission (sells exempt)
//   3. findStaleWorkingSell + the executor's stale-sell branch, including the
//      fallback path when the broker's working-order listing fails
//   4. filterUniverseByAffordability → held-symbol carve-out, so a position we
//      already own can never fall out of the candidate set and become
//      unexitable
//
// Each assertion below encodes a real incident: a stop-loss cancelled by an
// unrelated buy signal, an exit blocked forever behind an aged marketable
// limit, and a held name filtered out of the universe by the affordability
// screen.

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

type TickOrder = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  reason?: string;
};

// ---------------------------------------------------------------- netting

describe("buy/sell routing netting (pre-place aggregation)", () => {
  it("collapses repeated same-side tickets into one commissionable order", () => {
    const tick: TickOrder[] = [
      { symbol: "MKS.L", side: "buy", quantity: 100, price: 200 },
      { symbol: "MKS.L", side: "buy", quantity: 300, price: 210 },
      { symbol: "MKS.L", side: "buy", quantity: 100, price: 190 },
    ];
    const agg = aggregateOrders(tick);
    expect(agg.orders).toHaveLength(1);
    expect(agg.orders[0]!.quantity).toBe(500);
    // Quantity-weighted average, so downstream notional/cost stays correct.
    expect(agg.orders[0]!.price).toBeCloseTo((100 * 200 + 300 * 210 + 100 * 190) / 500, 6);
    expect(agg.ticketsSaved).toBe(2);
  });

  it("routes the SELL in full and drops the opposing BUY (risk reduction wins)", () => {
    const tick: TickOrder[] = [
      { symbol: "MKS.L", side: "buy", quantity: 400, price: 200, reason: "momentum add" },
      { symbol: "MKS.L", side: "sell", quantity: 250, price: 200, reason: "thesis break" },
    ];
    const agg = aggregateOrders(tick);
    const sells = agg.orders.filter((o) => o.side === "sell");
    const buys = agg.orders.filter((o) => o.side === "buy");
    expect(buys).toEqual([]);
    expect(sells).toHaveLength(1);
    // Regression: symmetric netting used to shrink the exit to 0 and leave a
    // losing position bleeding. The exit must survive at full size.
    expect(sells[0]!.quantity).toBe(250);
    expect(sells[0]!.reason).toBe("thesis break");
  });

  it("never shrinks an exit even when the opposing buy is far larger", () => {
    const agg = aggregateOrders([
      { symbol: "VMID.L", side: "buy", quantity: 5_000, price: 30 },
      { symbol: "VMID.L", side: "sell", quantity: 10, price: 30 },
    ] satisfies TickOrder[]);
    expect(agg.orders.map((o) => [o.side, o.quantity])).toEqual([["sell", 10]]);
  });

  it("leaves unrelated symbols untouched while netting one name", () => {
    const agg = aggregateOrders([
      { symbol: "MKS.L", side: "buy", quantity: 100, price: 200 },
      { symbol: "MKS.L", side: "sell", quantity: 100, price: 200 },
      { symbol: "AAPL", side: "buy", quantity: 5, price: 190 },
      { symbol: "XUKS.L", side: "sell", quantity: 20, price: 55 },
    ] satisfies TickOrder[]);
    const bySymbol = new Map(agg.orders.map((o) => [o.symbol, o]));
    expect(bySymbol.get("MKS.L")?.side).toBe("sell");
    expect(bySymbol.get("AAPL")?.quantity).toBe(5);
    expect(bySymbol.get("XUKS.L")?.quantity).toBe(20);
  });

  it("keeps netted output routable through the cost governor with sells exempt", () => {
    const agg = aggregateOrders([
      { symbol: "MKS.L", side: "buy", quantity: 400, price: 2 },
      { symbol: "MKS.L", side: "sell", quantity: 250, price: 2 },
      { symbol: "AAPL", side: "buy", quantity: 1, price: 20 },
    ] satisfies TickOrder[]);

    const nav = 10_300;
    const candidates: GovernorCandidate[] = agg.orders.map((o) => ({
      symbol: o.symbol,
      side: o.side,
      notionalBase: o.quantity * o.price,
      estCostBase: 8,
      isAdd: true,
    }));
    const plan = planAdmissions(candidates, {
      navBase: nav,
      ...governorForNav(nav),
      buysAlreadyToday: 99, // daily cap fully spent
      trailingCostBase: 10_000, // friction budget fully spent
      lastBuyDaysAgo: { "MKS.L": 0, AAPL: 0 }, // inside the add cooldown
    });

    const admitted = plan.decisions.filter((d) => d.kind === "admit");
    // Exits are never gated, whatever the budget/cooldown state says.
    expect(admitted.map((d) => d.candidate.symbol)).toEqual(["MKS.L"]);
    expect(admitted[0]!.candidate.side).toBe("sell");
    // The sub-min-ticket buy is skipped, not silently dropped.
    expect(
      plan.decisions.some((d) => d.kind === "skip" && d.candidate.symbol === "AAPL"),
    ).toBe(true);
  });
});

// ------------------------------------------------------- stale-sell branch

type Adapter = {
  listWorkingOrders?: () => Promise<WorkingSellOrder[]>;
  cancelOrder: (id: string) => Promise<{ ok: boolean; reason?: string }>;
};

type StaleSellOutcome =
  | { action: "placed"; cancelledBrokerOrderId: string | null }
  | { action: "skipped"; reason: string };

/**
 * Mirrors the executor's sell pre-flight in
 * `src/lib/live-executor.server.ts`: cancel an aged marketable limit before
 * submitting the replacement, refuse to double-sell when cancellation is
 * unconfirmed, and — when the broker listing itself fails — fall back to our
 * own order ledger so an exit is never stranded by a diagnostic outage.
 */
async function runSellPreflight(args: {
  adapter: Adapter;
  symbol: string;
  nowMs: number;
  /** Open sells for this symbol recorded in `live_orders`. */
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
  } catch (err) {
    if (args.ledgerOpenSells > 0) {
      return {
        action: "skipped",
        reason: "could not verify stale sell orders and an open sell exists in the ledger",
      };
    }
    void err;
    return { action: "placed", cancelledBrokerOrderId: null };
  }
}

const T0 = Date.parse("2026-08-21T10:00:00Z");

function workingSell(over: Partial<WorkingSellOrder> = {}): WorkingSellOrder {
  return {
    brokerOrderId: "W1",
    symbol: "MKS.L:xlon",
    buySell: "Sell",
    filledAmount: 0,
    amount: 250,
    orderTime: new Date(T0 - 20 * 60_000).toISOString(),
    ...over,
  };
}

describe("stale-sell fallback", () => {
  it("cancels an aged working sell and places the replacement", async () => {
    const cancelled: string[] = [];
    const out = await runSellPreflight({
      adapter: {
        listWorkingOrders: async () => [workingSell()],
        cancelOrder: async (id) => {
          cancelled.push(id);
          return { ok: true };
        },
      },
      symbol: "MKS.L",
      nowMs: T0,
      ledgerOpenSells: 1,
    });
    expect(cancelled).toEqual(["W1"]);
    expect(out).toEqual({ action: "placed", cancelledBrokerOrderId: "W1" });
  });

  it("matches the venue-suffixed broker symbol against the engine symbol", () => {
    expect(
      findStaleWorkingSell({
        working: [workingSell({ symbol: "MKS:xlon" })],
        symbol: "MKS.L",
        nowMs: T0,
      })?.brokerOrderId,
    ).toBe("W1");
  });

  it("leaves a fresh sell alone so a marketable limit gets its chance", async () => {
    const cancelled: string[] = [];
    const out = await runSellPreflight({
      adapter: {
        listWorkingOrders: async () => [
          workingSell({ orderTime: new Date(T0 - 60_000).toISOString() }),
        ],
        cancelOrder: async (id) => {
          cancelled.push(id);
          return { ok: true };
        },
      },
      symbol: "MKS.L",
      nowMs: T0,
      ledgerOpenSells: 1,
    });
    expect(cancelled).toEqual([]);
    expect(out.action).toBe("placed");
  });

  it("ignores aged BUY orders and fully filled sells", () => {
    expect(
      findStaleWorkingSell({
        working: [
          workingSell({ brokerOrderId: "B1", buySell: "Buy" }),
          workingSell({ brokerOrderId: "S-done", filledAmount: 250 }),
        ],
        symbol: "MKS.L",
        nowMs: T0,
      }),
    ).toBeNull();
  });

  it("withholds the replacement when cancellation is not confirmed", async () => {
    const out = await runSellPreflight({
      adapter: {
        listWorkingOrders: async () => [workingSell()],
        cancelOrder: async () => ({ ok: false, reason: "429 rate limited" }),
      },
      symbol: "MKS.L",
      nowMs: T0,
      ledgerOpenSells: 1,
    });
    expect(out).toEqual({
      action: "skipped",
      reason: "stale sell remains open; replacement withheld to prevent duplicate sale",
    });
  });

  it("falls back to our ledger and still exits when the broker listing fails", async () => {
    const out = await runSellPreflight({
      adapter: {
        listWorkingOrders: async () => {
          throw new Error("503 from /trade/v2/orders");
        },
        cancelOrder: async () => ({ ok: true }),
      },
      symbol: "MKS.L",
      nowMs: T0,
      ledgerOpenSells: 0,
    });
    // Regression: a diagnostic outage must not strand an exit.
    expect(out.action).toBe("placed");
  });

  it("holds back only when the listing fails AND our ledger shows an open sell", async () => {
    const out = await runSellPreflight({
      adapter: {
        listWorkingOrders: async () => {
          throw new Error("503 from /trade/v2/orders");
        },
        cancelOrder: async () => ({ ok: true }),
      },
      symbol: "MKS.L",
      nowMs: T0,
      ledgerOpenSells: 2,
    });
    expect(out).toEqual({
      action: "skipped",
      reason: "could not verify stale sell orders and an open sell exists in the ledger",
    });
  });

  it("places immediately when the adapter cannot list working orders at all", async () => {
    const out = await runSellPreflight({
      adapter: { cancelOrder: async () => ({ ok: true }) },
      symbol: "MKS.L",
      nowMs: T0,
      ledgerOpenSells: 3,
    });
    expect(out.action).toBe("placed");
  });
});

// -------------------------------------------------- held-symbol carve-out

describe("held-symbol carve-out in the affordability screen", () => {
  const universe = [
    { symbol: "MKS.L", name: "Marks & Spencer", asset_class: "stock" },
    { symbol: "BRK-A", name: "Berkshire", asset_class: "stock" },
    { symbol: "VMID.L", name: "Vanguard Mid", asset_class: "etf" },
  ] as unknown as Parameters<typeof filterUniverseByAffordability>[0]["fullUniverse"];

  const prices = new Map<string, number>([
    ["MKS.L", 2],
    ["BRK-A", 500_000],
    ["VMID.L", 30],
  ]);

  it("keeps a held name that the affordability screen would otherwise drop", () => {
    const res = filterUniverseByAffordability({
      fullUniverse: universe,
      priceMap: prices,
      heldSymbols: ["BRK-A"],
      cash: 1_000,
      totalValue: 10_300,
      perSymbolCapPct: 0.15,
      minTradeValue: 250,
      currency: "GBP",
    });
    const symbols = res.candidates.map((c) => c.symbol);
    // Regression: an unaffordable holding used to vanish from the candidate
    // set, so the AI never saw it and could never decide to exit it.
    expect(symbols).toContain("BRK-A");
    expect(symbols).toContain("MKS.L");
  });

  it("does not resurrect unaffordable names we do not hold", () => {
    const res = filterUniverseByAffordability({
      fullUniverse: universe,
      priceMap: prices,
      heldSymbols: [],
      cash: 1_000,
      totalValue: 10_300,
      perSymbolCapPct: 0.15,
      minTradeValue: 250,
      currency: "GBP",
    });
    expect(res.candidates.map((c) => c.symbol)).not.toContain("BRK-A");
  });

  it("never duplicates a held name that is already affordable", () => {
    const res = filterUniverseByAffordability({
      fullUniverse: universe,
      priceMap: prices,
      heldSymbols: ["MKS.L", "BRK-A"],
      cash: 5_000,
      totalValue: 10_300,
      perSymbolCapPct: 0.15,
      minTradeValue: 250,
      currency: "GBP",
    });
    const symbols = res.candidates.map((c) => c.symbol);
    expect(symbols.filter((s) => s === "MKS.L")).toHaveLength(1);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("carves held names in even when the per-symbol budget is below the min ticket", () => {
    const res = filterUniverseByAffordability({
      fullUniverse: universe,
      priceMap: prices,
      heldSymbols: ["MKS.L", "VMID.L"],
      cash: 10, // budget collapses; nothing is buyable
      totalValue: 10_300,
      perSymbolCapPct: 0.15,
      minTradeValue: 250,
      currency: "GBP",
    });
    const symbols = res.candidates.map((c) => c.symbol);
    expect(symbols).toEqual(expect.arrayContaining(["MKS.L", "VMID.L"]));
  });

  it("held names survive the screen and their exits survive the governor", () => {
    const res = filterUniverseByAffordability({
      fullUniverse: universe,
      priceMap: prices,
      heldSymbols: ["BRK-A"],
      cash: 0,
      totalValue: 10_300,
      perSymbolCapPct: 0.15,
      minTradeValue: 250,
      currency: "GBP",
    });
    expect(res.candidates.map((c) => c.symbol)).toContain("BRK-A");

    // The exit that visibility enables must then clear every buy-side gate.
    const nav = 10_300;
    const plan = planAdmissions(
      [{ symbol: "BRK-A", side: "sell", notionalBase: 40, estCostBase: 12 }],
      {
        navBase: nav,
        ...governorForNav(nav),
        buysAlreadyToday: 50,
        trailingCostBase: 99_999,
        lastBuyDaysAgo: { "BRK-A": 0 },
      },
    );
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0]!.kind).toBe("admit");
  });
});
