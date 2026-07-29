// Integration regression tests for two Saxo bugs we've hit before:
//
//   1. `SaxoAdapter.getClientKey()` must discover the ClientKey from
//      `/port/v1/users/me` and NOT use the env-provided key (which historically
//      contained an AccountKey by mistake, causing `/hist/v3/orders/{key}`
//      to 404 and leaving filled orders stuck on `submitted`). Result must be
//      cached so we don't re-hit `/users/me` on every historical lookup.
//
//   2. `SaxoAdapter.getPositions()` must value real broker positions even when
//      Saxo returns `CurrentPrice: 0`, by falling back to MarketValue /
//      Exposure / AverageOpenPrice. Missing Symbol on the aggregated
//      NetPosition row must be recovered via /ref/v1/instruments/details.
//
//   3. `reconcileOrderStatusesForPortfolio()` must translate Saxo history
//      into the local `live_orders.status` enum (filled / rejected /
//      cancelled), insert a matching `live_fills` row for fills, and leave
//      orders still in the working list alone.
//
// These lock in the behaviour so a future refactor of saxo.server.ts /
// order-reconciliation.server.ts can't silently regress them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- supabaseAdmin mock ------------------------------------------------
// The adapter writes to `live_broker_log` on every request and the
// reconciler updates `live_orders` / inserts into `live_fills`. Capture
// all writes so we can assert on them; reject nothing.

interface Update { table: string; patch: Record<string, unknown>; id?: string }
interface Insert { table: string; row: Record<string, unknown> }
interface Query { table: string; filters: Array<[string, unknown]>; inFilters: Array<[string, unknown[]]>; gte?: [string, unknown] }

const updates: Update[] = [];
const inserts: Insert[] = [];
const queries: Query[] = [];
let openOrdersFixture: Array<Record<string, unknown>> = [];

function makeAdminMock() {
  return {
    from(table: string) {
      const q: Query = { table, filters: [], inFilters: [] };
      const chain: any = {
        select() { return chain; },
        eq(col: string, val: unknown) { q.filters.push([col, val]); return chain; },
        in(col: string, vals: unknown[]) { q.inFilters.push([col, vals]); return chain; },
        gte(col: string, val: unknown) { q.gte = [col, val]; return chain; },
        order() { return chain; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(col: string, val: unknown) {
              updates.push({ table, patch, id: col === "id" ? String(val) : undefined });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
        then(resolve: (v: unknown) => unknown) {
          queries.push(q);
          if (table === "live_orders") {
            return Promise.resolve({ data: openOrdersFixture, error: null }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: makeAdminMock(),
}));

// ---- fetch stub --------------------------------------------------------

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;
const originalFetch = globalThis.fetch;
let fetchHandler: FetchHandler | null = null;
const fetchCalls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  updates.length = 0;
  inserts.length = 0;
  queries.length = 0;
  fetchCalls.length = 0;
  openOrdersFixture = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, method: init?.method ?? "GET" });
    if (!fetchHandler) throw new Error(`unexpected fetch: ${url}`);
    const res = await fetchHandler(url, init);
    return res as Response;
  }) as typeof fetch;
});

afterEach(() => {
  fetchHandler = null;
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function importAdapter() {
  const mod = await import("../brokers/saxo.server");
  return mod;
}

// ------------------------------------------------------------------------
// 1. getClientKey — discovered via /port/v1/users/me, cached, used for /hist
// ------------------------------------------------------------------------

describe("SaxoAdapter.getClientKey (via getHistoricalOrder)", () => {
  it("prefers the ClientKey from /port/v1/users/me over the env-provided key", async () => {
    const { SaxoAdapter } = await importAdapter();
    fetchHandler = (url) => {
      if (url.includes("/port/v1/users/me")) {
        return jsonResponse({ ClientKey: "REAL-CLIENT-KEY-123", UserKey: "u-1" });
      }
      if (url.includes("/hist/v3/orders/REAL-CLIENT-KEY-123")) {
        return jsonResponse({
          Data: [{
            OrderId: "ORD-1", Status: "Filled",
            Amount: 10, FilledAmount: 10, AverageOpenPrice: 42.5,
            ExecutionTimeClose: "2026-06-01T10:00:00Z",
          }],
        });
      }
      // If the adapter (wrongly) uses the env-provided clientKey we'll land here.
      if (url.includes("/hist/v3/orders/WRONG-ACCOUNT-KEY")) {
        return jsonResponse({ Message: "not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const adapter = new SaxoAdapter({
      env: "sim",
      token: "tok",
      userId: "user-1",
      clientKey: "WRONG-ACCOUNT-KEY", // simulate the historical misconfig
    });

    const hit = await adapter.getHistoricalOrder("ORD-1", "2026-05-01T00:00:00Z");
    expect(hit).not.toBeNull();
    expect(hit!.status).toBe("Filled");
    expect(hit!.avgPrice).toBe(42.5);
    expect(hit!.filledAmount).toBe(10);

    // Must have hit /users/me and the correct /hist URL — never the env key.
    expect(fetchCalls.some((c) => c.url.includes("/port/v1/users/me"))).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes("/hist/v3/orders/REAL-CLIENT-KEY-123"))).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes("WRONG-ACCOUNT-KEY"))).toBe(false);
  });

  it("caches the discovered ClientKey across subsequent history calls", async () => {
    const { SaxoAdapter } = await importAdapter();
    let usersMeCalls = 0;
    fetchHandler = (url) => {
      if (url.includes("/port/v1/users/me")) {
        usersMeCalls++;
        return jsonResponse({ ClientKey: "CK-CACHED" });
      }
      if (url.includes("/hist/v3/orders/CK-CACHED")) {
        return jsonResponse({ Data: [{ OrderId: "O", Status: "Filled", Amount: 1, FilledAmount: 1 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const adapter = new SaxoAdapter({ env: "sim", token: "t", userId: "u" });
    await adapter.getHistoricalOrder("O", "2026-01-01T00:00:00Z");
    await adapter.getHistoricalOrder("O", "2026-01-01T00:00:00Z");
    await adapter.getHistoricalOrder("O", "2026-01-01T00:00:00Z");
    expect(usersMeCalls).toBe(1);
  });

  it("falls back to the env clientKey when /port/v1/users/me errors", async () => {
    const { SaxoAdapter } = await importAdapter();
    fetchHandler = (url) => {
      if (url.includes("/port/v1/users/me")) return jsonResponse({ error: "boom" }, 500);
      if (url.includes("/hist/v3/orders/ENV-FALLBACK-KEY")) {
        return jsonResponse({ Data: [{ OrderId: "X", Status: "Filled", Amount: 2, FilledAmount: 2 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const adapter = new SaxoAdapter({
      env: "sim", token: "t", userId: "u", clientKey: "ENV-FALLBACK-KEY",
    });
    const hit = await adapter.getHistoricalOrder("X", "2026-01-01T00:00:00Z");
    expect(hit?.status).toBe("Filled");
  });

  it("returns null when history lookup fails (endpoint not enabled)", async () => {
    const { SaxoAdapter } = await importAdapter();
    fetchHandler = (url) => {
      if (url.includes("/port/v1/users/me")) return jsonResponse({ ClientKey: "CK" });
      if (url.includes("/hist/")) return jsonResponse({ Message: "not enabled" }, 404);
      throw new Error(`unexpected fetch: ${url}`);
    };
    const adapter = new SaxoAdapter({ env: "sim", token: "t", userId: "u" });
    const hit = await adapter.getHistoricalOrder("Z", "2026-01-01T00:00:00Z");
    expect(hit).toBeNull();
  });
});

// ------------------------------------------------------------------------
// 1b. getBalance — app-visible cash after unsettled transactions
// ------------------------------------------------------------------------

describe("SaxoAdapter.getBalance", () => {
  it("subtracts negative TransactionsNotBooked so cash matches the Saxo app after unsettled buys", async () => {
    const { SaxoAdapter } = await importAdapter();
    fetchHandler = (url) => {
      if (url.includes("/port/v1/accounts/me")) {
        return jsonResponse({
          Data: [{ AccountKey: "ACC-1", Active: true, LegalAssetTypes: ["Stock", "Etf"] }],
        });
      }
      if (url.includes("/port/v1/balances") && url.includes("AccountKey=ACC-1")) {
        return jsonResponse({
          CashBalance: 8419.49,
          TransactionsNotBooked: -5917.54,
          CashAvailableForTrading: 2501.95,
          SpendingPower: 2501.95,
          TotalValue: 10282.95,
          Currency: "GBP",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const adapter = new SaxoAdapter({ env: "live", token: "t", userId: "u" });
    const balance = await adapter.getBalance();

    expect(balance.cash).toBeCloseTo(2501.95, 10);
    expect(balance.totalValue).toBeCloseTo(10282.95, 10);
    expect(balance.transactionsNotBooked).toBeCloseTo(-5917.54, 10);
    expect(balance.cash).not.toBeCloseTo(8419.49, 2);
  });

  it("does not treat margin-style SpendingPower as cash", async () => {
    const { SaxoAdapter } = await importAdapter();
    fetchHandler = (url) => {
      if (url.includes("/port/v1/accounts/me")) {
        return jsonResponse({ Data: [{ AccountKey: "ACC-1", Active: true }] });
      }
      if (url.includes("/port/v1/balances") && url.includes("AccountKey=ACC-1")) {
        return jsonResponse({
          CashBalance: 100,
          TransactionsNotBooked: 0,
          SpendingPower: 1000,
          TotalValue: 600,
          Currency: "GBP",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const adapter = new SaxoAdapter({ env: "live", token: "t", userId: "u" });
    const balance = await adapter.getBalance();

    expect(balance.cash).toBe(100);
    expect(balance.spendingPower).toBe(1000);
  });
});

// ------------------------------------------------------------------------
// 2. getPositions — valuation fallbacks when CurrentPrice = 0
// ------------------------------------------------------------------------

describe("SaxoAdapter.getPositions", () => {
  it("requests the field-groups needed for symbol + quantity + prices", async () => {
    const { SaxoAdapter } = await importAdapter();
    fetchHandler = (url) => {
      expect(url).toContain("/port/v1/netpositions/me");
      // Missing any of these historically caused every position to drop out.
      expect(url).toContain("DisplayAndFormat");
      expect(url).toContain("NetPositionBase");
      expect(url).toContain("NetPositionView");
      return jsonResponse({ Data: [] });
    };
    const adapter = new SaxoAdapter({ env: "sim", token: "t", userId: "u" });
    const positions = await adapter.getPositions();
    expect(positions).toEqual([]);
  });

  it("prices a position from MarketValue when CurrentPrice is 0", async () => {
    const { SaxoAdapter } = await importAdapter();
    fetchHandler = () => jsonResponse({
      Data: [{
        NetPositionBase: { Amount: 10, AverageOpenPrice: 17.5, Uic: 111, AssetType: "Stock" },
        NetPositionView: {
          CurrentPrice: 0,          // Saxo sometimes returns 0 here
          MarketValue: 200,         // 10 units * 20 = 200
          Exposure: 200,
        },
        DisplayAndFormat: { Symbol: "LLOY:xlon", Currency: "GBP" },
      }],
    });
    const adapter = new SaxoAdapter({ env: "sim", token: "t", userId: "u" });
    const [pos] = await adapter.getPositions();
    expect(pos.symbol).toBe("LLOY:xlon");
    expect(pos.quantity).toBe(10);
    expect(pos.avgPrice).toBe(17.5);
    // MarketValue / |quantity| = 200 / 10 = 20
    expect(pos.marketPrice).toBe(20);
  });

  it("falls back to AverageOpenPrice when no market-value fields are present", async () => {
    const { SaxoAdapter } = await importAdapter();
    fetchHandler = () => jsonResponse({
      Data: [{
        NetPositionBase: { Amount: 5, AverageOpenPrice: 12, Uic: 222, AssetType: "Etf" },
        NetPositionView: { CurrentPrice: 0 },
        DisplayAndFormat: { Symbol: "VUKE:xlon", Currency: "GBP" },
      }],
    });
    const adapter = new SaxoAdapter({ env: "sim", token: "t", userId: "u" });
    const [pos] = await adapter.getPositions();
    expect(pos.marketPrice).toBe(12); // last-ditch fallback to avgPrice
    expect(pos.avgPrice).toBe(12);
  });

  it("recovers a missing Symbol via /ref/v1/instruments/details", async () => {
    const { SaxoAdapter } = await importAdapter();
    fetchHandler = (url) => {
      if (url.includes("/port/v1/netpositions/me")) {
        return jsonResponse({
          Data: [{
            NetPositionBase: { Amount: 3, AverageOpenPrice: 100, Uic: 555, AssetType: "Stock" },
            NetPositionView: { CurrentPrice: 105 },
            DisplayAndFormat: { Currency: "GBP" }, // no Symbol
          }],
        });
      }
      if (url.includes("/ref/v1/instruments/details/555/Stock")) {
        return jsonResponse({ Symbol: "BARC:xlon", CurrencyCode: "GBP", AssetType: "Stock" });
      }
      throw new Error(`unexpected: ${url}`);
    };
    const adapter = new SaxoAdapter({ env: "sim", token: "t", userId: "u" });
    const [pos] = await adapter.getPositions();
    expect(pos.symbol).toBe("BARC:xlon");
    expect(pos.marketPrice).toBe(105);
  });
});

// ------------------------------------------------------------------------
// 3. reconcileOrderStatusesForPortfolio — status mapping + fill insert
// ------------------------------------------------------------------------

describe("reconcileOrderStatusesForPortfolio", () => {
  interface FakeAdapter {
    env: "sim";
    listWorkingOrders: () => Promise<Array<{ brokerOrderId: string; symbol: string; status: string; amount: number; filledAmount: number }>>;
    getHistoricalOrder: (id: string, since: string) => Promise<{
      brokerOrderId: string; status: string; amount: number; filledAmount: number;
      avgPrice: number | null; filledAt: string | null; reason?: string;
    } | null>;
  }

  function makeAdapter(overrides: Partial<FakeAdapter>): FakeAdapter {
    return {
      env: "sim",
      listWorkingOrders: async () => [],
      getHistoricalOrder: async () => null,
      ...overrides,
    };
  }

  it("marks orders filled and inserts a live_fills row using the historical fill data", async () => {
    openOrdersFixture = [{
      id: "order-a", symbol: "LLOY.L", side: "buy", quantity: 5,
      status: "submitted", broker_order_id: "BRK-A", submitted_at: null,
      created_at: "2026-06-01T00:00:00Z",
    }];
    const adapter = makeAdapter({
      listWorkingOrders: async () => [],
      getHistoricalOrder: async () => ({
        brokerOrderId: "BRK-A", status: "Filled", amount: 5, filledAmount: 5,
        avgPrice: 44.2, filledAt: "2026-06-01T10:00:00Z",
      }),
    });
    const { reconcileOrderStatusesForPortfolio } =
      await import("../order-reconciliation.server");
    const summary = await reconcileOrderStatusesForPortfolio({
      portfolioId: "pf-1", userId: "u-1",
      adapter: adapter as never,
    });
    expect(summary.filled).toBe(1);
    expect(summary.rows[0].outcome).toBe("filled");
    const upd = updates.find((u) => u.table === "live_orders" && u.id === "order-a");
    expect(upd?.patch.status).toBe("filled");
    const fill = inserts.find((i) => i.table === "live_fills");
    expect(fill).toBeTruthy();
    expect(fill!.row.symbol).toBe("LLOY.L");
    expect(fill!.row.quantity).toBe(5);
    expect(fill!.row.fill_price).toBe(44.2);
    expect(fill!.row.broker_fill_id).toBe("BRK-A");
  });

  it("marks orders rejected and stores the broker reason without inserting a fill", async () => {
    openOrdersFixture = [{
      id: "order-b", symbol: "BARC.L", side: "buy", quantity: 10,
      status: "submitted", broker_order_id: "BRK-B",
      submitted_at: null, created_at: "2026-06-01T00:00:00Z",
    }];
    const adapter = makeAdapter({
      getHistoricalOrder: async () => ({
        brokerOrderId: "BRK-B", status: "Rejected", amount: 10, filledAmount: 0,
        avgPrice: null, filledAt: null, reason: "Insufficient buying power",
      }),
    });
    const { reconcileOrderStatusesForPortfolio } =
      await import("../order-reconciliation.server");
    const summary = await reconcileOrderStatusesForPortfolio({
      portfolioId: "pf-1", userId: "u-1", adapter: adapter as never,
    });
    expect(summary.rejected).toBe(1);
    const upd = updates.find((u) => u.table === "live_orders" && u.id === "order-b");
    expect(upd?.patch.status).toBe("rejected");
    expect(upd?.patch.reject_reason).toBe("Insufficient buying power");
    expect(inserts.some((i) => i.table === "live_fills")).toBe(false);
  });

  it("leaves orders alone when they are still in the broker's working list", async () => {
    openOrdersFixture = [{
      id: "order-c", symbol: "VUKE.L", side: "buy", quantity: 4,
      status: "submitted", broker_order_id: "BRK-C",
      submitted_at: null, created_at: "2026-06-01T00:00:00Z",
    }];
    const adapter = makeAdapter({
      listWorkingOrders: async () => [{
        brokerOrderId: "BRK-C", symbol: "VUKE.L", status: "Working",
        amount: 4, filledAmount: 0,
      }],
    });
    const { reconcileOrderStatusesForPortfolio } =
      await import("../order-reconciliation.server");
    const summary = await reconcileOrderStatusesForPortfolio({
      portfolioId: "pf-1", userId: "u-1", adapter: adapter as never,
    });
    expect(summary.stillWorking).toBe(1);
    // The reconciler now syncs "submitted" → "working" onto the local row
    // to reflect broker acknowledgement, but must not touch anything else
    // (no reject_reason, no fills, no broker id churn).
    const upd = updates.find((u) => u.table === "live_orders" && u.id === "order-c");
    expect(upd?.patch).toEqual({ status: "working" });
    expect(inserts.some((i) => i.table === "live_fills")).toBe(false);

  });

  it("flags orders that never received a broker id as no_broker_id (no writes)", async () => {
    openOrdersFixture = [{
      id: "order-d", symbol: "SPY", side: "buy", quantity: 2,
      status: "submitted", broker_order_id: null,
      submitted_at: null, created_at: "2026-06-01T00:00:00Z",
    }];
    const { reconcileOrderStatusesForPortfolio } =
      await import("../order-reconciliation.server");
    const adapter = makeAdapter({});
    const summary = await reconcileOrderStatusesForPortfolio({
      portfolioId: "pf-1", userId: "u-1", adapter: adapter as never,
    });
    expect(summary.rows[0].outcome).toBe("no_broker_id");
    expect(updates.some((u) => u.table === "live_orders" && u.id === "order-d")).toBe(false);
  });
});
