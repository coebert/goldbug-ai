// Tests for the one-off kernel revaluation of historical snapshots.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: null }));
vi.mock("@/lib/fx.server", () => ({
  getFxRate: async (from: string) => (from === "USD" ? { rate: 0.8 } : { rate: 1 }),
}));

import {
  buildDayValuationInputs,
  loadCloseHistory,
  backfillValuationHistory,
} from "../historical-backfill.server";
import { positionsOn, type RevalueHolding, type RevalueFill } from "../../equity-snapshot-revalue";

const holding = (over: Partial<RevalueHolding> = {}): RevalueHolding => ({
  symbol: "ISF:xlon",
  quantity: 100,
  avg_cost: 800,
  asset_class: "equity",
  instrument_ccy: "GBP",
  opened_at: "2026-01-01T00:00:00Z",
  ...over,
});

function priceMap(entries: Record<string, Record<string, number>>) {
  return new Map(
    Object.entries(entries).map(([sym, series]) => [sym, new Map(Object.entries(series))]),
  );
}

describe("buildDayValuationInputs", () => {
  it("folds LSE pence closes into pounds exactly once", () => {
    const book = positionsOn([holding()], [], "2026-02-01");
    const { holdings, normalizedPrices } = buildDayValuationInputs(
      book,
      priceMap({ "ISF.L": { "2026-01-20": 850 } }),
      "2026-02-01",
    );
    expect(holdings).toHaveLength(1);
    expect(normalizedPrices.get("ISF:XLON")).toBeCloseTo(8.5, 6);
  });

  it("carries the last close forward across a price gap", () => {
    const book = positionsOn([holding({ symbol: "AAPL", instrument_ccy: "USD" })], [], "2026-03-10");
    const { normalizedPrices } = buildDayValuationInputs(
      book,
      priceMap({ AAPL: { "2026-03-02": 190, "2026-03-15": 200 } }),
      "2026-03-10",
    );
    expect(normalizedPrices.get("AAPL")).toBe(190);
  });

  it("omits a price when nothing is cached, leaving the cost-basis fallback to the kernel", () => {
    const book = positionsOn([holding({ symbol: "XYZ" })], [], "2026-02-01");
    const { holdings, normalizedPrices } = buildDayValuationInputs(book, priceMap({}), "2026-02-01");
    expect(holdings).toHaveLength(1);
    expect(normalizedPrices.size).toBe(0);
  });

  it("reconstructs the book by undoing later fills", () => {
    const fills: RevalueFill[] = [
      { symbol: "ISF.L", side: "buy", quantity: 60, filled_at: "2026-02-10T10:00:00Z" },
    ];
    const before = buildDayValuationInputs(
      positionsOn([holding({ quantity: 100 })], fills, "2026-02-01"),
      priceMap({}),
      "2026-02-01",
    );
    const after = buildDayValuationInputs(
      positionsOn([holding({ quantity: 100 })], fills, "2026-02-20"),
      priceMap({}),
      "2026-02-20",
    );
    expect(Number(before.holdings[0]!.quantity)).toBe(40);
    expect(Number(after.holdings[0]!.quantity)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function makeClient(tables: Record<string, Row[]>, upserts: Row[]) {
  const builder = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const api: any = {
      select: () => api,
      eq: (col: string, v: unknown) => {
        rows = rows.filter((r) => r[col] === v);
        return api;
      },
      in: (col: string, vs: unknown[]) => {
        rows = rows.filter((r) => vs.includes(r[col] as never));
        return api;
      },
      gt: (col: string, v: number) => {
        rows = rows.filter((r) => Number(r[col]) > v);
        return api;
      },
      gte: (col: string, v: string) => {
        rows = rows.filter((r) => String(r[col]) >= v);
        return api;
      },
      lt: () => api,
      limit: () => api,
      order: () => api,
      maybeSingle: async () => ({ data: rows[0] ?? null }),
      upsert: async (payload: Row) => {
        if (table === "equity_snapshots") upserts.push(payload);
        return { error: null };
      },
      insert: async () => ({ error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return api;
  };
  return { from: builder } as any;
}

describe("backfillValuationHistory", () => {
  let upserts: Row[];

  beforeEach(() => {
    upserts = [];
  });

  const baseTables = () => ({
    portfolios: [{ id: "p1", name: "High Risk Sim", currency: "GBP", cash: 1000 }],
    holdings: [
      {
        symbol: "ISF:xlon",
        quantity: 100,
        avg_cost: 800,
        asset_class: "equity",
        opened_at: "2026-01-01T00:00:00Z",
        instrument_ccy: "GBP",
        portfolio_id: "p1",
      },
    ],
    live_fills: [] as Row[],
    price_cache: [
      { symbol: "ISF.L", price_date: "2026-02-01", close: 800 },
      { symbol: "ISF.L", price_date: "2026-02-02", close: 810 },
    ],
    // 100x inflated history: pence treated as pounds.
    equity_snapshots: [
      { snapshot_date: "2026-02-01", cash: 1000, holdings_value: 80000, total_value: 81000 },
      { snapshot_date: "2026-02-02", cash: 1000, holdings_value: 81000, total_value: 82000 },
    ],
  });

  it("rewrites GBX-inflated history into pounds", async () => {
    const client = makeClient(baseTables(), upserts);
    const res = await backfillValuationHistory(client, {});

    expect(res.totals.daysScanned).toBe(2);
    expect(res.totals.written).toBe(2);
    expect(upserts).toHaveLength(2);
    // 100 shares @ 800p = £800, plus £1000 cash.
    expect(Number(upserts[0]!.total_value)).toBeCloseTo(1800, 2);
    expect(Number(upserts[1]!.total_value)).toBeCloseTo(1810, 2);
    expect(upserts[0]!.source).toBe("revalue");
    expect(res.portfolios[0]!.worstRatio).toBeGreaterThan(40);
  });

  it("is idempotent: a second pass over corrected rows writes nothing", async () => {
    const tables = baseTables();
    tables.equity_snapshots = [
      { snapshot_date: "2026-02-01", cash: 1000, holdings_value: 800, total_value: 1800 },
      { snapshot_date: "2026-02-02", cash: 1000, holdings_value: 810, total_value: 1810 },
    ];
    const res = await backfillValuationHistory(makeClient(tables, upserts), {});
    expect(res.totals.written).toBe(0);
    expect(res.totals.unchanged).toBe(2);
    expect(upserts).toHaveLength(0);
  });

  it("writes nothing in dry-run mode but still reports the deltas", async () => {
    const res = await backfillValuationHistory(makeClient(baseTables(), upserts), {
      dryRun: true,
    });
    expect(res.dryRun).toBe(true);
    expect(upserts).toHaveLength(0);
    expect(res.portfolios[0]!.days.every((d) => d.status === "dry_run")).toBe(true);
    expect(res.portfolios[0]!.days[0]!.total).toBeCloseTo(1800, 2);
  });

  it("preserves stored cash and reports provenance warnings", async () => {
    const tables = baseTables();
    tables.price_cache = [];
    const res = await backfillValuationHistory(makeClient(tables, upserts), { dryRun: true });
    const day = res.portfolios[0]!.days[0]!;
    expect(day.cash).toBe(1000);
    expect(day.degraded).toBe(true);
    expect(day.warnings).toContain("cost_basis_fallback");
  });

  it("returns an empty result for a portfolio with no snapshots", async () => {
    const tables = baseTables();
    tables.equity_snapshots = [];
    const res = await backfillValuationHistory(makeClient(tables, upserts), {});
    expect(res.totals.daysScanned).toBe(0);
    expect(res.portfolios[0]!.days).toHaveLength(0);
  });
});

describe("loadCloseHistory", () => {
  it("indexes closes by symbol spelling and skips non-positive prices", async () => {
    const client = makeClient(
      {
        price_cache: [
          { symbol: "ISF.L", price_date: "2026-02-01", close: 800 },
          { symbol: "ISF.L", price_date: "2026-02-02", close: 0 },
        ],
      },
      [],
    );
    const map = await loadCloseHistory(client, ["ISF:xlon"], "2026-01-01");
    expect(map.get("ISF.L")?.get("2026-02-01")).toBe(800);
    expect(map.get("ISF.L")?.has("2026-02-02")).toBe(false);
  });
});
