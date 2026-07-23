// Verifies pending_slices ownership guards in execution-slicer.server.ts.
// The slicer uses supabaseAdmin (which bypasses RLS) so each helper must
// prove portfolio ownership itself and log a structured warning otherwise.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PortfolioRow = { id: string; user_id: string };
type SliceRow = {
  id: string;
  portfolio_id: string;
  remaining_qty: number;
  slices_done: number;
  slice_count: number;
};

const PF_ALICE = "11111111-1111-4111-8111-111111111111";
const PF_BOB   = "22222222-2222-4222-8222-222222222222";
const U_ALICE  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U_BOB    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SLICE_A  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const portfolios: PortfolioRow[] = [
  { id: PF_ALICE, user_id: U_ALICE },
  { id: PF_BOB, user_id: U_BOB },
];
const slices: SliceRow[] = [
  { id: SLICE_A, portfolio_id: PF_ALICE, remaining_qty: 10, slices_done: 0, slice_count: 4 },
];

const updates: Array<Record<string, unknown>> = [];
const inserts: Array<Record<string, unknown>> = [];

// Chainable stub that mimics the fluent PostgREST builder just enough for the
// slicer's queries. Any table not in `portfolios`/`pending_slices` returns
// empty data rather than throwing so the test surface stays narrow.
function makeAdminMock() {
  return {
    from(table: string) {
      const state: {
        table: string;
        filters: Record<string, unknown>;
        payload?: Record<string, unknown>;
        mode: "select" | "update" | "insert";
      } = { table, filters: {}, mode: "select" };

      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.insert = (row: Record<string, unknown>) => {
        state.mode = "insert";
        state.payload = row;
        inserts.push({ table, row });
        return chain;
      };
      chain.update = (patch: Record<string, unknown>) => {
        state.mode = "update";
        state.payload = patch;
        return chain;
      };
      chain.eq = (col: string, val: unknown) => {
        state.filters[col] = val;
        return chain;
      };
      chain.lt = () => chain;
      chain.lte = () => chain;
      chain.order = () => chain;
      chain.single = async () => resolve();
      chain.maybeSingle = async () => resolve();
      chain.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onFulfilled);

      function resolve() {
        if (state.mode === "insert") {
          return { data: { id: "new-slice" }, error: null };
        }
        if (state.mode === "update") {
          updates.push({ table, filters: { ...state.filters }, patch: state.payload });
          return { data: null, error: null };
        }
        // select
        if (table === "portfolios") {
          const row = portfolios.find((p) => p.id === state.filters.id) ?? null;
          return { data: row, error: null };
        }
        if (table === "pending_slices") {
          const row = slices.find((s) => s.id === state.filters.id) ?? null;
          return { data: row, error: null };
        }
        return { data: null, error: null };
      }
      return chain;
    },
  };
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: makeAdminMock(),
}));

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  updates.length = 0;
  inserts.length = 0;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

function securityWarnings() {
  return warnSpy.mock.calls.filter(
    (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).startsWith("SECURITY:pending_slices"),
  );
}

describe("pending_slices ownership enforcement", () => {
  it("blocks maybeSliceOrder when caller does not own the portfolio", async () => {
    const { maybeSliceOrder } = await import("../execution-slicer.server");
    await expect(
      maybeSliceOrder({
        portfolioId: "pf-alice",
        ownerUserId: "user-bob", // attacker
        decisionId: null,
        symbol: "AAPL",
        side: "buy",
        totalQty: 100,
        priceHint: 100, // notional 10k > threshold
      }),
    ).rejects.toThrow(/ownership mismatch/);
    expect(inserts).toHaveLength(0);
    const warn = securityWarnings();
    expect(warn.length).toBeGreaterThan(0);
    expect(warn[0][1]).toContain("ownership_mismatch");
  });

  it("blocks tickSlicer cross-portfolio access and skips updates", async () => {
    const { tickSlicer } = await import("../execution-slicer.server");
    await expect(tickSlicer("pf-alice", "user-bob")).rejects.toThrow(/ownership mismatch/);
    expect(updates).toHaveLength(0);
    expect(securityWarnings()[0][1]).toContain("ownership_mismatch");
  });

  it("blocks recordSliceFill when caller does not own the slice's portfolio", async () => {
    const { recordSliceFill } = await import("../execution-slicer.server");
    await expect(recordSliceFill("slice-alice", "user-bob", 5)).rejects.toThrow(/ownership mismatch/);
    // No update to pending_slices should have been issued.
    expect(updates.filter((u) => u.table === "pending_slices")).toHaveLength(0);
    expect(securityWarnings()[0][1]).toContain("ownership_mismatch");
  });

  it("logs and rejects missing identifiers without touching the DB", async () => {
    const { tickSlicer } = await import("../execution-slicer.server");
    await expect(tickSlicer("", "user-alice")).rejects.toThrow(/missing/);
    expect(updates).toHaveLength(0);
    expect(securityWarnings()[0][1]).toContain("missing_ids");
  });

  it("allows the legitimate owner through tickSlicer without emitting warnings", async () => {
    const { tickSlicer } = await import("../execution-slicer.server");
    await expect(tickSlicer("pf-alice", "user-alice")).resolves.toBeDefined();
    expect(securityWarnings()).toHaveLength(0);
  });
});
