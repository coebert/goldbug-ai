// Regression integration test for the 2026-07-27 incident where the
// real-money portfolio's starting pot was corrupted (£300 shown as £125)
// AND today's equity snapshot understated total value (£301.89 shown as
// £191.95). Both bugs lived in `syncLiveCashFromBroker`:
//
//   1. When live holdings existed, an external deposit was silently ignored
//      because starting_cash was only adjusted for cash-only portfolios.
//      Only unexplained cash deltas (broker delta minus recent fill P&L)
//      should be treated as deposits; explained deltas (buy/sell fills) must
//      leave starting_cash alone.
//
//   2. CASH_SYNC that ran between a fill and the next HOLDINGS_SYNC wrote a
//      snapshot with the *stale* previous holdings_value. It must prefer the
//      broker's authoritative TotalValue when present.
//
// These tests drive the real `syncLiveCashFromBroker` end-to-end with a
// mocked Saxo adapter and an in-memory fake of the tables it touches.

import { describe, it, expect, vi, beforeEach } from "vitest";

// The Saxo adapter is loaded via a dynamic import inside the function under
// test, so we mock the module before importing anything.
const balanceStub = vi.fn();
vi.mock("@/lib/brokers/saxo.server", () => ({
  buildSaxoAdapter: vi.fn(async () => ({
    getBalance: balanceStub,
  })),
}));

import { syncLiveCashFromBroker } from "@/lib/live-cash-sync.server";
import type { OwnedDbClient, ScopedDbClient } from "@/lib/_server/owned-client";

// ---------------------------------------------------------------------------
// Minimal in-memory fake for the exact query chains syncLiveCashFromBroker
// uses. Every chain method returns `this` until a terminal (`maybeSingle`,
// `insert`, `update().eq()`, `.limit()`, `.gte()`, awaiting the builder).
// ---------------------------------------------------------------------------

type Portfolio = {
  id: string;
  user_id: string;
  mode: "live_prod" | "live_sim" | "backtest" | "paper";
  current_cash: number;
  starting_cash: number;
  live_paused: boolean;
  currency: string;
  cash_by_ccy?: Record<string, number> | null;
};
type Holding = { id: string; portfolio_id: string };
type Fill = {
  portfolio_id: string;
  side: "buy" | "sell";
  quantity: number;
  fill_price: number;
  fee: number;
  filled_at: string;
};
type Snapshot = {
  id: string;
  portfolio_id: string;
  snapshot_date: string;
  cash: number;
  holdings_value: number;
  total_value: number | null;
};
type BrokerLog = {
  portfolio_id: string | null;
  user_id: string;
  broker: string;
  env: string;
  method: string;
  status: number | null;
  request: unknown;
  response: unknown;
  error: string | null;
  created_at: string;
};

type Store = {
  portfolios: Portfolio[];
  holdings: Holding[];
  live_fills: Fill[];
  equity_snapshots: Snapshot[];
  live_broker_log: BrokerLog[];
};

function makeStore(portfolios: Portfolio[], holdings: Holding[] = [], fills: Fill[] = []): Store {
  return {
    portfolios: [...portfolios],
    holdings: [...holdings],
    live_fills: [...fills],
    equity_snapshots: [],
    live_broker_log: [],
  };
}

function makeDb(store: Store): ScopedDbClient {
  let idCounter = 1;

  function query(table: keyof Store) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    const builder = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      gte(col: string, val: string) {
        filters.push((r) => String(r[col]) >= val);
        return builder;
      },
      order(col: string, opts: { ascending: boolean }) {
        order = { col, asc: opts.ascending };
        return builder;
      },
      limit(n: number) {
        limit = n;
        // Awaiting `.limit(...)` is used for the holdings existence check.
        return Object.assign(
          Promise.resolve({ data: applyRead(), error: null }),
          builder,
        );
      },
      async maybeSingle() {
        const rows = applyRead();
        return { data: rows[0] ?? null, error: null };
      },
      then(resolve: (v: { data: unknown[]; error: null }) => void) {
        // Awaiting the builder directly returns the filtered rows (used for
        // the live_fills read).
        resolve({ data: applyRead(), error: null });
      },
      insert(row: Record<string, unknown>) {
        const withMeta = {
          id: `row_${idCounter++}`,
          created_at: new Date().toISOString(),
          ...row,
        };
        (store[table] as Array<Record<string, unknown>>).push(withMeta);
        return Promise.resolve({ error: null });
      },
      upsert(row: Record<string, unknown>) {
        return builder.insert(row);
      },
      update(patch: Record<string, unknown>) {
        return {
          async eq(col: string, val: unknown) {
            const rows = store[table] as Array<Record<string, unknown>>;
            for (const r of rows) {
              if (r[col] === val) Object.assign(r, patch);
            }
            return { error: null };
          },
        };
      },
    };
    function applyRead(): Array<Record<string, unknown>> {
      let rows = (store[table] as Array<Record<string, unknown>>).filter((r) =>
        filters.every((f) => f(r)),
      );
      if (order) {
        const { col, asc } = order;
        rows = [...rows].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limit != null) rows = rows.slice(0, limit);
      return rows;
    }
    return builder;
  }

  return {
    from(table: string) {
      return query(table as keyof Store);
    },
  } as unknown as ScopedDbClient;
}

function makeOwned(store: Store, userId: string): OwnedDbClient {
  return { db: makeDb(store), userId, isAdmin: false };
}

const PID = "7c825889-81a1-4c32-9087-26d3847be6b1";
const UID = "u1";

beforeEach(() => {
  balanceStub.mockReset();
});

describe("syncLiveCashFromBroker — starting pot & snapshot regression", () => {
  it("Bug #1: external deposit while holdings exist bumps starting_cash", async () => {
    // Baseline: user funded £100, deployed most of it, £14.98 cash left.
    // A £200 external deposit arrives → broker cash jumps to £214.98.
    // There are no recent fills that would explain the £200 delta, so the
    // executor must treat it as a deposit and grow starting_cash to £300.
    const store = makeStore(
      [{
        id: PID, user_id: UID, mode: "live_prod",
        current_cash: 14.98, starting_cash: 100,
        live_paused: false, currency: "GBP",
      }],
      [{ id: "h1", portfolio_id: PID }],
      [], // no recent fills — the deposit is entirely unexplained
    );
    balanceStub.mockResolvedValue({
      cash: 214.98, cashAvailable: 214.98,
      totalValue: 301.89, currency: "GBP",
    });

    const res = await syncLiveCashFromBroker(PID, makeOwned(store, UID));

    expect(res).toMatchObject({
      skipped: false,
      brokerCash: 214.98,
      newCash: 214.98,
      newStartingCash: 300, // 100 + 200 delta
    });
    expect(store.portfolios[0].starting_cash).toBe(300);
    expect(store.portfolios[0].current_cash).toBe(214.98);
  });

  it("Bug #1 negative: a delta that is fully explained by recent fills does NOT move starting_cash", async () => {
    // £300 pot, user just bought £150 of shares → cash fell to £150. That
    // cash move is fully accounted for by the fill and must NOT reduce the
    // recorded starting pot (which used to happen: buys silently ate into
    // it).
    const store = makeStore(
      [{
        id: PID, user_id: UID, mode: "live_prod",
        current_cash: 300, starting_cash: 300,
        live_paused: false, currency: "GBP",
      }],
      [{ id: "h1", portfolio_id: PID }],
      [{
        portfolio_id: PID, side: "buy", quantity: 10, fill_price: 15, fee: 0,
        filled_at: new Date().toISOString(),
      }],
    );
    balanceStub.mockResolvedValue({
      cash: 150, cashAvailable: 150,
      totalValue: 301.89, currency: "GBP",
    });

    const res = await syncLiveCashFromBroker(PID, makeOwned(store, UID));

    expect(res).toMatchObject({ skipped: false, newStartingCash: 300 });
    expect(store.portfolios[0].starting_cash).toBe(300);
  });

  it("Bug #2: today's snapshot uses broker TotalValue, not stale local holdings_value", async () => {
    // A previous CASH_SYNC/HOLDINGS_SYNC left a stale holdings_value of
    // £176.97 on today's snapshot. A new fill has since happened at the
    // broker so cash dropped and TotalValue climbed to £301.89. The rewrite
    // MUST use TotalValue − brokerCash (= 286.91) for holdings_value, not
    // the stale 176.97.
    const store = makeStore(
      [{
        id: PID, user_id: UID, mode: "live_prod",
        current_cash: 152.78, starting_cash: 300,
        live_paused: false, currency: "GBP",
      }],
      [{ id: "h1", portfolio_id: PID }],
      [{
        // The fill explains the -137.80 cash delta, so starting_cash is
        // left alone — isolating the assertion to the snapshot logic.
        portfolio_id: PID, side: "buy", quantity: 10, fill_price: 13.78, fee: 0,
        filled_at: new Date().toISOString(),
      }],
    );
    const today = new Date().toISOString().slice(0, 10);
    store.equity_snapshots.push({
      id: "old", portfolio_id: PID, snapshot_date: today,
      cash: 152.78, holdings_value: 176.97, total_value: 329.75,
    });
    balanceStub.mockResolvedValue({
      cash: 14.98, cashAvailable: 14.98,
      totalValue: 301.89, currency: "GBP",
    });

    const res = await syncLiveCashFromBroker(PID, makeOwned(store, UID));

    expect(res).toMatchObject({ skipped: false, brokerCash: 14.98 });
    const snap = store.equity_snapshots.find((s) => s.snapshot_date === today);
    expect(snap).toBeDefined();
    expect(snap!.cash).toBe(14.98);
    expect(snap!.total_value).toBeCloseTo(301.89, 10);
    expect(snap!.holdings_value).toBeCloseTo(301.89 - 14.98, 10);
    // The stale £176.97 must NOT persist.
    expect(snap!.holdings_value).not.toBeCloseTo(176.97, 3);
    // And there must still be exactly one row for today.
    expect(store.equity_snapshots.filter((s) => s.snapshot_date === today)).toHaveLength(1);
  });

  it("Bug #2 fallback: with no TotalValue, snapshot uses the latest known holdings_value (does not zero it out)", async () => {
    // Broker returns no TotalValue (e.g. transient Saxo omission). The
    // snapshot must fall back to the last known holdings_value rather than
    // silently writing 0.
    const store = makeStore(
      [{
        id: PID, user_id: UID, mode: "live_prod",
        current_cash: 150, starting_cash: 300,
        live_paused: false, currency: "GBP",
      }],
      [{ id: "h1", portfolio_id: PID }],
      [{
        portfolio_id: PID, side: "buy", quantity: 10, fill_price: 15, fee: 0,
        filled_at: new Date().toISOString(),
      }],
    );
    // Prior snapshot from yesterday carries the last known holdings_value.
    store.equity_snapshots.push({
      id: "yday", portfolio_id: PID, snapshot_date: "2000-01-01",
      cash: 300, holdings_value: 150, total_value: 450,
    });
    balanceStub.mockResolvedValue({
      cash: 100, cashAvailable: 100,
      totalValue: null, currency: "GBP",
    });

    await syncLiveCashFromBroker(PID, makeOwned(store, UID));

    const today = new Date().toISOString().slice(0, 10);
    const snap = store.equity_snapshots.find((s) => s.snapshot_date === today);
    expect(snap).toBeDefined();
    expect(snap!.holdings_value).toBe(150);
    expect(snap!.total_value).toBe(250);
  });

  it("uses broker ledger cash for equity, not lower spendable cash reserved by Saxo", async () => {
    // Reproduces the stale-warning screenshot: Saxo ledger cash is £124.60
    // but spendable cash / SpendingPower is only £14.98 because the broker
    // has reserved/ring-fenced funds. Equity accounting must keep using the
    // ledger cash that reconciles to TotalValue; otherwise CASH_SYNC records
    // a fake -£109.62 withdrawal, lowers starting_cash, and leaves today's
    // snapshot appearing stale.
    const today = new Date().toISOString().slice(0, 10);
    const store = makeStore(
      [{
        id: PID, user_id: UID, mode: "live_prod",
        current_cash: 124.6, starting_cash: 300,
        live_paused: false, currency: "GBP",
      }],
      [{ id: "h1", portfolio_id: PID }],
      [],
    );
    store.equity_snapshots.push({
      id: "today", portfolio_id: PID, snapshot_date: today,
      cash: 124.6, holdings_value: 177.23, total_value: 301.83,
    });
    balanceStub.mockResolvedValue({
      cash: 124.6,
      cashAvailable: 14.98,
      spendingPower: 14.98,
      totalValue: 301.83,
      currency: "GBP",
    });

    const res = await syncLiveCashFromBroker(PID, makeOwned(store, UID));

    expect(res).toMatchObject({ skipped: true, reason: "no material drift" });
    expect(store.portfolios[0].current_cash).toBe(124.6);
    expect(store.portfolios[0].starting_cash).toBe(300);
    const snap = store.equity_snapshots.find((s) => s.snapshot_date === today);
    expect(snap).toMatchObject({
      cash: 124.6,
      holdings_value: 177.23,
      total_value: 301.83,
    });
    expect(store.live_broker_log).toHaveLength(0);
  });

  it("refreshes a stale base-currency wallet even when scalar cash already matches the broker", async () => {
    // Regression for the 2026-07-28 live trading blockage: current_cash had
    // already synced to the topped-up broker balance, but cash_by_ccy.GBP was
    // still the pre-deposit amount. Downstream affordability checks read the
    // JSON wallet, so the trading engine saw only £124.60 available despite
    // £10,014.98 ledger cash. A no-drift sync must still rewrite the wallet.
    const today = new Date().toISOString().slice(0, 10);
    const store = makeStore(
      [{
        id: PID, user_id: UID, mode: "live_prod",
        current_cash: 10014.98, starting_cash: 10190.38,
        live_paused: false, currency: "GBP",
        cash_by_ccy: { GBP: 124.6 },
      }],
      [{ id: "h1", portfolio_id: PID }],
      [],
    );
    store.equity_snapshots.push({
      id: "today", portfolio_id: PID, snapshot_date: today,
      cash: 10014.98, holdings_value: 0, total_value: 10014.98,
    });
    balanceStub.mockResolvedValue({
      cash: 10014.98,
      cashAvailable: 10014.98,
      spendingPower: 10014.98,
      totalValue: 10014.98,
      currency: "GBP",
    });

    const res = await syncLiveCashFromBroker(PID, makeOwned(store, UID));

    expect(res).toMatchObject({ skipped: true, reason: "no material drift" });
    expect(store.portfolios[0].current_cash).toBe(10014.98);
    expect(store.portfolios[0].cash_by_ccy).toEqual({ GBP: 10014.98 });
    expect(store.portfolios[0].starting_cash).toBe(10190.38);
    expect(store.live_broker_log.at(-1)).toMatchObject({
      method: "CASH_SYNC",
      status: 200,
      error: null,
    });
  });
});
