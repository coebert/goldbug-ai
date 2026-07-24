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
        portfolioId: PF_ALICE,
        ownerUserId: U_BOB, // attacker
        decisionId: null,
        symbol: "AAPL",
        side: "buy",
        totalQty: 100,
        priceHint: 100, // notional 10k > threshold
      }),
    ).rejects.toThrow(/ownership mismatch/);
    expect(inserts.filter((i) => i.table === "pending_slices")).toHaveLength(0);
    const warn = securityWarnings();
    expect(warn.length).toBeGreaterThan(0);
    expect(warn[0][1]).toContain("ownership_mismatch");
  });

  it("blocks tickSlicer cross-portfolio access and skips updates", async () => {
    const { tickSlicer } = await import("../execution-slicer.server");
    await expect(tickSlicer(PF_ALICE, U_BOB)).rejects.toThrow(/ownership mismatch/);
    expect(updates).toHaveLength(0);
    expect(securityWarnings()[0][1]).toContain("ownership_mismatch");
  });

  it("blocks recordSliceFill when caller does not own the slice's portfolio", async () => {
    const { recordSliceFill } = await import("../execution-slicer.server");
    await expect(recordSliceFill(SLICE_A, U_BOB, 5)).rejects.toThrow(/ownership mismatch/);
    expect(updates.filter((u) => u.table === "pending_slices")).toHaveLength(0);
    expect(securityWarnings()[0][1]).toContain("ownership_mismatch");
  });

  it("allows the legitimate owner through tickSlicer without emitting warnings", async () => {
    const { tickSlicer } = await import("../execution-slicer.server");
    await expect(tickSlicer(PF_ALICE, U_ALICE)).resolves.toBeDefined();
    expect(securityWarnings()).toHaveLength(0);
  });
});

describe("pending_slices input validation", () => {
  it("rejects empty portfolioId before any DB call and logs validation_failed", async () => {
    const { tickSlicer } = await import("../execution-slicer.server");
    await expect(tickSlicer("", U_ALICE)).rejects.toThrow(/invalid input for tickSlicer/);
    expect(updates).toHaveLength(0);
    expect(securityWarnings()[0][1]).toContain("validation_failed");
  });

  it("rejects non-UUID portfolio_id in maybeSliceOrder", async () => {
    const { maybeSliceOrder } = await import("../execution-slicer.server");
    await expect(
      maybeSliceOrder({
        portfolioId: "not-a-uuid",
        ownerUserId: U_ALICE,
        decisionId: null,
        symbol: "AAPL",
        side: "buy",
        totalQty: 100,
        priceHint: 100,
      }),
    ).rejects.toThrow(/invalid input/);
    expect(inserts.filter((i) => i.table === "pending_slices")).toHaveLength(0);
    expect(securityWarnings()[0][1]).toContain("validation_failed");
  });

  it("rejects unsafe symbol characters (injection-shaped strings)", async () => {
    const { maybeSliceOrder } = await import("../execution-slicer.server");
    await expect(
      maybeSliceOrder({
        portfolioId: PF_ALICE,
        ownerUserId: U_ALICE,
        decisionId: null,
        symbol: "AAPL'; DROP TABLE pending_slices;--",
        side: "buy",
        totalQty: 100,
        priceHint: 100,
      }),
    ).rejects.toThrow(/invalid input/);
    expect(inserts.filter((i) => i.table === "pending_slices")).toHaveLength(0);
    expect(securityWarnings()[0][1]).toContain("validation_failed");
  });

  it("rejects negative filledQty in recordSliceFill", async () => {
    const { recordSliceFill } = await import("../execution-slicer.server");
    await expect(recordSliceFill(SLICE_A, U_ALICE, -1)).rejects.toThrow(/invalid input/);
    expect(updates.filter((u) => u.table === "pending_slices")).toHaveLength(0);
    expect(securityWarnings()[0][1]).toContain("validation_failed");
  });

  it("clamps slices to the allowed range via schema", async () => {
    const { maybeSliceOrder } = await import("../execution-slicer.server");
    // 99 slices is well outside [2, 8]
    await expect(
      maybeSliceOrder({
        portfolioId: PF_ALICE,
        ownerUserId: U_ALICE,
        decisionId: null,
        symbol: "AAPL",
        side: "buy",
        totalQty: 100,
        priceHint: 100,
        slices: 99,
      }),
    ).rejects.toThrow(/invalid input/);
    expect(inserts.filter((i) => i.table === "pending_slices")).toHaveLength(0);
  });
});

