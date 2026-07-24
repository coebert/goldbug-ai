// Regression test for addSimFunds: verifies the handler upserts today's
// equity_snapshot so the dashboard's "Simulated equity" tile (which is
// derived from equity_snapshots) reflects the top-up immediately, rather
// than waiting for the next hourly run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSimFundsHandler } from "../sim-funds.server";

const PF = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Captured = {
  portfolioUpdate?: Record<string, unknown>;
  fundEventInsert?: Record<string, unknown>;
  snapshotUpsert?: { row: Record<string, unknown>; opts: { onConflict: string } };
};

function makeSupabase(opts: {
  portfolio: { id: string; mode: string; currency: string; starting_cash: number; current_cash: number };
  latestSnapshot: { snapshot_date: string; cash: number; holdings_value: number; total_value: number } | null;
}) {
  const captured: Captured = {};
  const from = (table: string) => {
    if (table === "portfolios") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: opts.portfolio, error: null }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: () => ({
            select: () => ({
              single: async () => {
                captured.portfolioUpdate = patch;
                return {
                  data: {
                    id: opts.portfolio.id,
                    starting_cash: Number(patch.starting_cash),
                    current_cash: Number(patch.current_cash),
                    currency: opts.portfolio.currency,
                  },
                  error: null,
                };
              },
            }),
          }),
        }),
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
      };
    }
    if (table === "sim_fund_events") {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
        update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
        insert: async (row: Record<string, unknown>) => {
          captured.fundEventInsert = row;
          return { error: null };
        },
        upsert: async () => ({ error: null }),
      };
    }
    if (table === "equity_snapshots") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: null }),
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: opts.latestSnapshot, error: null }),
              }),
            }),
          }),
        }),
        update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
        insert: async () => ({ error: null }),
        upsert: async (row: Record<string, unknown>, o: { onConflict: string }) => {
          captured.snapshotUpsert = { row, opts: o };
          return { error: null };
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
  return { supabase: { from } as unknown as Parameters<typeof addSimFundsHandler>[1], captured };
}

const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe("addSimFundsHandler", () => {
  it("upserts today's equity snapshot with new cash + preserved holdings when no snapshot exists today", async () => {
    const { supabase, captured } = makeSupabase({
      portfolio: { id: PF, mode: "paper", currency: "GBP", starting_cash: 1000, current_cash: 1000 },
      latestSnapshot: null,
    });

    const res = await addSimFundsHandler({ id: PF, amount: 999_000 }, supabase, USER);

    expect(res.ok).toBe(true);
    expect(captured.portfolioUpdate).toMatchObject({ current_cash: 1_000_000, starting_cash: 1_000_000 });
    expect(captured.fundEventInsert).toMatchObject({ portfolio_id: PF, amount: 999_000, balance_after: 1_000_000 });
    expect(captured.snapshotUpsert).toBeDefined();
    expect(captured.snapshotUpsert!.opts.onConflict).toBe("portfolio_id,snapshot_date");
    expect(captured.snapshotUpsert!.row).toMatchObject({
      portfolio_id: PF,
      snapshot_date: today(),
      cash: 1_000_000,
      holdings_value: 0,
      total_value: 1_000_000,
    });
  });

  it("adds the top-up to today's existing snapshot cash while preserving holdings_value", async () => {
    const { supabase, captured } = makeSupabase({
      portfolio: { id: PF, mode: "paper", currency: "GBP", starting_cash: 1000, current_cash: 1000 },
      latestSnapshot: { snapshot_date: today(), cash: 400, holdings_value: 600, total_value: 1000 },
    });

    await addSimFundsHandler({ id: PF, amount: 500 }, supabase, USER);

    expect(captured.snapshotUpsert!.row).toMatchObject({
      snapshot_date: today(),
      cash: 900, // 400 + 500 top-up
      holdings_value: 600,
      total_value: 1500,
    });
  });

  it("starts a fresh snapshot from newCurrent when the latest snapshot is from a previous day", async () => {
    const { supabase, captured } = makeSupabase({
      portfolio: { id: PF, mode: "paper", currency: "GBP", starting_cash: 1000, current_cash: 800 },
      latestSnapshot: { snapshot_date: "2000-01-01", cash: 200, holdings_value: 600, total_value: 800 },
    });

    await addSimFundsHandler({ id: PF, amount: 200 }, supabase, USER);

    // newCurrent = 800 + 200 = 1000; holdings carried from latest snapshot.
    expect(captured.snapshotUpsert!.row).toMatchObject({
      snapshot_date: today(),
      cash: 1000,
      holdings_value: 600,
      total_value: 1600,
    });
  });

  it("refuses to top up real-money portfolios", async () => {
    const { supabase } = makeSupabase({
      portfolio: { id: PF, mode: "live_prod", currency: "GBP", starting_cash: 1000, current_cash: 1000 },
      latestSnapshot: null,
    });
    await expect(addSimFundsHandler({ id: PF, amount: 100 }, supabase, USER)).rejects.toThrow(/broker/i);
  });
});
