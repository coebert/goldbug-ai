import { describe, expect, it } from "vitest";
import {
  writeCashSyncSnapshot,
  type CashSyncSnapshotClient,
} from "../live-cash-sync.server";

// ---------------------------------------------------------------------------
// Fake in-memory equity_snapshots table. Crucially, it does NOT enforce a
// UNIQUE(portfolio_id, snapshot_date) constraint — it happily accepts
// duplicate rows for the same (portfolio, date). That mirrors what happens
// in environments where the constraint was never applied: the code must
// itself avoid producing duplicates via read-then-update, not by relying on
// onConflict.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  portfolio_id: string;
  snapshot_date: string;
  cash: number;
  holdings_value: number;
  total_value: number | null;
};

function makeFakeClient(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  let idCounter = initial.length + 1;
  const errors: {
    onSelect?: string;
    onUpdate?: string;
    onInsert?: string;
  } = {};

  const client: CashSyncSnapshotClient = {
    from(table) {
      if (table !== "equity_snapshots") throw new Error(`unexpected table ${table}`);
      return {
        select(_cols: string) {
          return {
            eq(_col: "portfolio_id", pid: string) {
              return {
                eq(_col2: "snapshot_date", date: string) {
                  return {
                    async maybeSingle() {
                      if (errors.onSelect) return { data: null, error: { message: errors.onSelect } };
                      const matches = rows.filter(
                        (r) => r.portfolio_id === pid && r.snapshot_date === date,
                      );
                      // maybeSingle returns the first row if any exist. The
                      // production code must be resilient regardless.
                      const first = matches[0] ?? null;
                      return {
                        data: first ? { id: first.id, total_value: first.total_value } : null,
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        },
        update(patch) {
          return {
            async eq(_col: "id", id: string) {
              if (errors.onUpdate) return { error: { message: errors.onUpdate } };
              const idx = rows.findIndex((r) => r.id === id);
              if (idx < 0) return { error: { message: "row not found" } };
              rows[idx] = { ...rows[idx], ...patch };
              return { error: null };
            },
          };
        },
        async insert(row) {
          if (errors.onInsert) return { error: { message: errors.onInsert } };
          rows.push({ id: `r${idCounter++}`, ...row });
          return { error: null };
        },
      };
    },
  };

  return { client, rows, errors };
}

const PID = "11111111-1111-4111-8111-111111111111";

describe("writeCashSyncSnapshot", () => {
  it("inserts a new snapshot when none exists for the date", async () => {
    const { client, rows } = makeFakeClient();
    const res = await writeCashSyncSnapshot(client, {
      portfolioId: PID,
      snapshotDate: "2026-07-24",
      cash: 300,
      holdingsValue: 175.86,
    });
    expect(res).toEqual({ action: "inserted", totalValue: 475.86 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      portfolio_id: PID,
      snapshot_date: "2026-07-24",
      cash: 300,
      holdings_value: 175.86,
      total_value: 475.86,
    });
  });

  it("updates the existing row for the same (portfolio, date) instead of duplicating", async () => {
    const { client, rows } = makeFakeClient([
      {
        id: "r1",
        portfolio_id: PID,
        snapshot_date: "2026-07-24",
        cash: 329.75,
        holdings_value: 0,
        total_value: 329.75,
      },
    ]);
    const res = await writeCashSyncSnapshot(client, {
      portfolioId: PID,
      snapshotDate: "2026-07-24",
      cash: 124.6,
      holdingsValue: 175.86,
    });
    expect(res.action).toBe("updated");
    if (res.action === "updated") {
      expect(res.totalValue).toBeCloseTo(300.46, 10);
      expect(res.previousTotalValue).toBe(329.75);
    }
    // Still exactly ONE row for that (portfolio, date), even though the fake
    // client has no unique constraint to fall back on.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("r1");
    expect(rows[0].cash).toBe(124.6);
    expect(rows[0].holdings_value).toBe(175.86);
    expect(rows[0].total_value).toBeCloseTo(300.46, 10);
  });

  it("never produces duplicate rows for the same date across repeated syncs", async () => {
    const { client, rows } = makeFakeClient();
    await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 300, holdingsValue: 0,
    });
    await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 305, holdingsValue: 0,
    });
    await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 310, holdingsValue: 5,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cash: 310, holdings_value: 5, total_value: 315 });
  });

  it("keeps snapshots for different dates independent", async () => {
    const { client, rows } = makeFakeClient();
    await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-23", cash: 300, holdingsValue: 0,
    });
    await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 305, holdingsValue: 0,
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.snapshot_date).sort()).toEqual(["2026-07-23", "2026-07-24"]);
  });

  it("keeps snapshots for different portfolios on the same date independent", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const { client, rows } = makeFakeClient();
    await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 300, holdingsValue: 0,
    });
    await writeCashSyncSnapshot(client, {
      portfolioId: OTHER, snapshotDate: "2026-07-24", cash: 1000, holdingsValue: 40,
    });
    expect(rows).toHaveLength(2);
    const byPid = Object.fromEntries(rows.map((r) => [r.portfolio_id, r]));
    expect(byPid[PID].total_value).toBe(300);
    expect(byPid[OTHER].total_value).toBe(1040);
  });

  it("returns an error result and does not write when the SELECT fails", async () => {
    const { client, rows, errors } = makeFakeClient();
    errors.onSelect = "connection reset";
    const res = await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 300, holdingsValue: 0,
    });
    expect(res).toEqual({ action: "error", message: "connection reset" });
    expect(rows).toHaveLength(0);
  });

  it("returns an error result when the INSERT fails on a fresh row", async () => {
    const { client, rows, errors } = makeFakeClient();
    errors.onInsert = "insert denied";
    const res = await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 300, holdingsValue: 0,
    });
    expect(res).toEqual({ action: "error", message: "insert denied" });
    expect(rows).toHaveLength(0);
  });

  it("returns an error result when the UPDATE fails on an existing row", async () => {
    const { client, rows, errors } = makeFakeClient([
      { id: "r1", portfolio_id: PID, snapshot_date: "2026-07-24", cash: 300, holdings_value: 0, total_value: 300 },
    ]);
    errors.onUpdate = "update denied";
    const res = await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 305, holdingsValue: 0,
    });
    expect(res).toEqual({ action: "error", message: "update denied" });
    // Original row untouched.
    expect(rows).toHaveLength(1);
    expect(rows[0].cash).toBe(300);
  });

  it("rejects non-finite cash or holdings values without writing", async () => {
    const { client, rows } = makeFakeClient();
    const r1 = await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: Number.NaN, holdingsValue: 0,
    });
    const r2 = await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 300, holdingsValue: Number.POSITIVE_INFINITY,
    });
    expect(r1.action).toBe("error");
    expect(r2.action).toBe("error");
    expect(rows).toHaveLength(0);
  });

  it("recomputes total_value from cash + holdings on every write", async () => {
    const { client, rows } = makeFakeClient();
    await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 100.1, holdingsValue: 200.2,
    });
    expect(rows[0].total_value).toBeCloseTo(300.3, 10);
    await writeCashSyncSnapshot(client, {
      portfolioId: PID, snapshotDate: "2026-07-24", cash: 50, holdingsValue: 25,
    });
    expect(rows[0].total_value).toBe(75);
  });
});
