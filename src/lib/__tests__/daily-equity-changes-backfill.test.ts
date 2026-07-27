import { describe, it, expect, vi, beforeEach } from "vitest";
import { backfillPortfolioDailyChanges } from "../daily-equity-changes-backfill.server";

type Row = Record<string, unknown>;

function makeSupabase(opts: {
  equity: Row[];
  deposits?: Row[];
  cashSyncs?: Row[];
  upserts: Row[][];
}) {
  return {
    from(table: string) {
      const b: {
        _table: string;
        _filters: Record<string, unknown>;
        select: () => typeof b;
        eq: (col: string, v: unknown) => typeof b;
        gte: (col: string, v: unknown) => typeof b;
        order: () => typeof b;
        upsert: (rows: Row[]) => Promise<{ error: null }>;
        then: (r: (v: { data: Row[]; error: null }) => unknown) => Promise<unknown>;
      } = {
        _table: table,
        _filters: {},
        select() {
          return b;
        },
        eq(_c, _v) {
          return b;
        },
        gte(_c, _v) {
          return b;
        },
        order() {
          return b;
        },
        async upsert(rows: Row[]) {
          opts.upserts.push(rows);
          return { error: null };
        },
        then(resolve) {
          let data: Row[] = [];
          if (b._table === "equity_snapshots") data = opts.equity;
          else if (b._table === "sim_fund_events") data = opts.deposits ?? [];
          else if (b._table === "live_broker_log") data = opts.cashSyncs ?? [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return b;
    },
  } as unknown as Parameters<typeof backfillPortfolioDailyChanges>[0];
}

describe("backfillPortfolioDailyChanges", () => {
  beforeEach(() => vi.useRealTimers());

  it("writes one row per consecutive snapshot pair inside the window", async () => {
    const upserts: Row[][] = [];
    const supabase = makeSupabase({
      equity: [
        { snapshot_date: "2026-07-20", total_value: 1000 },
        { snapshot_date: "2026-07-21", total_value: 1010 },
        { snapshot_date: "2026-07-22", total_value: 1005 },
      ],
      upserts,
    });
    const res = await backfillPortfolioDailyChanges(
      supabase,
      { id: "11111111-1111-1111-1111-111111111111", mode: "paper" },
      365,
    );
    expect(res.rowsWritten).toBe(2);
    expect(upserts[0]).toHaveLength(2);
    const first = upserts[0][0] as Record<string, number | string>;
    expect(first.change_date).toBe("2026-07-21");
    expect(Number(first.pct)).toBeCloseTo(1, 6);
  });

  it("nets deposits out of pnl", async () => {
    const upserts: Row[][] = [];
    const supabase = makeSupabase({
      equity: [
        { snapshot_date: "2026-07-20", total_value: 1000 },
        { snapshot_date: "2026-07-21", total_value: 1200 },
      ],
      deposits: [{ created_at: "2026-07-21T09:00:00Z", amount: 200 }],
      upserts,
    });
    await backfillPortfolioDailyChanges(
      supabase,
      { id: "22222222-2222-2222-2222-222222222222", mode: "paper" },
      365,
    );
    const row = upserts[0][0] as Record<string, number>;
    expect(row.net_flow).toBe(200);
    expect(row.pnl).toBe(0);
    expect(row.pct).toBe(0);
  });

  it("skips when there are fewer than two snapshots", async () => {
    const upserts: Row[][] = [];
    const supabase = makeSupabase({
      equity: [{ snapshot_date: "2026-07-22", total_value: 1000 }],
      upserts,
    });
    const res = await backfillPortfolioDailyChanges(
      supabase,
      { id: "33333333-3333-3333-3333-333333333333", mode: "paper" },
      365,
    );
    expect(res.rowsWritten).toBe(0);
    expect(res.skipped).toBe("not-enough-snapshots");
    expect(upserts).toHaveLength(0);
  });
});
