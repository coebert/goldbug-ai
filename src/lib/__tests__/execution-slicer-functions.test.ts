// Integration tests for the authenticated server-function wrappers in
// `execution-slicer.functions.ts`. These verify that every path returns the
// structured discriminated-union response — `{ ok: true, data }` on success
// and `{ ok: false, error: { code, message, issues? } }` on any failure —
// across invalid inputs, ownership mismatches, missing rows, and unexpected
// throws from the underlying server helpers.
//
// We stub `createServerFn` so the builder chain composes a plain async
// function `(payload) => handler({ data: validated, context })`, injecting a
// trusted `context.userId` the way `requireSupabaseAuth` would in production.
// The dynamic import of `./execution-slicer.server` is mocked per test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const U_ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PF_ALICE = "11111111-1111-4111-8111-111111111111";
const SLICE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DECISION_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// Response-status recorder: the fail() helper calls setResponseStatus so the
// HTTP layer surfaces 4xx/5xx alongside the JSON body.
const statusCalls: number[] = [];

vi.mock("@tanstack/react-start/server", () => ({
  setResponseStatus: (code: number) => {
    statusCalls.push(code);
  },
}));

// Minimal createServerFn stub: preserves the .middleware/.inputValidator/
// .handler chain and returns a callable that mimics the RPC entry point.
vi.mock("@tanstack/react-start", () => {
  function make(): any {
    let validator: ((raw: unknown) => unknown) | null = null;
    let handler: ((args: { data: unknown; context: unknown }) => unknown) | null = null;
    const api: any = {
      middleware() { return api; },
      inputValidator(fn: (raw: unknown) => unknown) { validator = fn; return api; },
      handler(fn: (args: { data: unknown; context: unknown }) => unknown) {
        handler = fn;
        return async (payload: { data?: unknown } = {}) => {
          if (!handler) throw new Error("handler missing");
          let data: unknown = payload?.data;
          if (validator) {
            try { data = validator(data); }
            catch (err) { throw err; }
          }
          return handler({ data, context: { userId: U_ALICE, supabase: null } });
        };
      },
    };
    return api;
  }
  return { createServerFn: (_opts?: unknown) => make() };
});

// Middleware is inert in tests — auth context is injected by our stub above.
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: {},
}));

// Per-test overrides of the underlying slicer helpers.
const serverImpl = {
  maybeSliceOrder: vi.fn<(input: unknown) => Promise<unknown>>(),
  tickSlicer: vi.fn<(portfolioId: string, userId: string) => Promise<unknown>>(),
  recordSliceFill: vi.fn<(sliceId: string, userId: string, qty: number, note?: string) => Promise<void>>(),
};

vi.mock("../execution-slicer.server", () => serverImpl);

// Load AFTER mocks so the module picks up the stubbed createServerFn.
const mod = await import("../execution-slicer.functions");
const { enqueueSlice, tickSlices, recordFill } = mod;

type ErrResult = { ok: false; error: { code: string; message: string; issues?: Array<{ path: string; message: string }> } };
type OkResult<T> = { ok: true; data: T };

function isErr(r: unknown): r is ErrResult {
  return !!r && typeof r === "object" && (r as { ok?: boolean }).ok === false;
}

beforeEach(() => {
  statusCalls.length = 0;
  serverImpl.maybeSliceOrder.mockReset();
  serverImpl.tickSlicer.mockReset();
  serverImpl.recordSliceFill.mockReset();
});
afterEach(() => vi.clearAllMocks());

// ---- enqueueSlice ----------------------------------------------------------
describe("enqueueSlice", () => {
  const valid = {
    portfolioId: PF_ALICE,
    decisionId: DECISION_A,
    symbol: "AAPL",
    side: "buy" as const,
    totalQty: 40,
    priceHint: 190.5,
    slices: 4,
    ttlMinutes: 60,
  };

  it("returns { ok: true, data } for a queued slice", async () => {
    serverImpl.maybeSliceOrder.mockResolvedValue({ sliceId: SLICE_A, sliceQty: 10, slices: 4 });
    const r = (await enqueueSlice({ data: valid })) as OkResult<{ sliceId: string }>;
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ sliceId: SLICE_A, sliceQty: 10, slices: 4 });
    // Server helper receives the injected trusted user id, not the client's.
    expect(serverImpl.maybeSliceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: U_ALICE, portfolioId: PF_ALICE }),
    );
    expect(statusCalls).toEqual([]);
  });

  it("returns { ok: true, data: { skipped } } when helper returns null (below threshold)", async () => {
    serverImpl.maybeSliceOrder.mockResolvedValue(null);
    const r = await enqueueSlice({ data: valid });
    expect(r).toEqual({ ok: true, data: { skipped: true, reason: "below_threshold" } });
  });

  it("rejects an invalid symbol before hitting the server helper", async () => {
    await expect(enqueueSlice({ data: { ...valid, symbol: "bad symbol!" } })).rejects.toBeTruthy();
    expect(serverImpl.maybeSliceOrder).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid portfolioId at the input-validator boundary", async () => {
    await expect(enqueueSlice({ data: { ...valid, portfolioId: "not-a-uuid" } })).rejects.toBeTruthy();
    expect(serverImpl.maybeSliceOrder).not.toHaveBeenCalled();
  });

  it("rejects negative quantities", async () => {
    await expect(enqueueSlice({ data: { ...valid, totalQty: -5 } })).rejects.toBeTruthy();
  });

  it("maps ownership-mismatch throws to { ok:false, code: ownership_mismatch }", async () => {
    serverImpl.maybeSliceOrder.mockRejectedValue(new Error("SECURITY:pending_slices ownership mismatch"));
    const r = (await enqueueSlice({ data: valid })) as ErrResult;
    expect(isErr(r)).toBe(true);
    expect(r.error.code).toBe("ownership_mismatch");
    expect(statusCalls).toEqual([403]);
  });

  it("maps portfolio_not_found throws to { ok:false, code: not_found }", async () => {
    serverImpl.maybeSliceOrder.mockRejectedValue(new Error("portfolio_not_found"));
    const r = (await enqueueSlice({ data: valid })) as ErrResult;
    expect(r.error.code).toBe("not_found");
    expect(statusCalls).toEqual([404]);
  });

  it("classifies unknown throws as internal_error", async () => {
    serverImpl.maybeSliceOrder.mockRejectedValue(new Error("db exploded"));
    const r = (await enqueueSlice({ data: valid })) as ErrResult;
    expect(r.error.code).toBe("internal_error");
    expect(r.error.message).toMatch(/slicer/i);
    expect(statusCalls).toEqual([500]);
  });
});

// ---- tickSlices ------------------------------------------------------------
describe("tickSlices", () => {
  const valid = { portfolioId: PF_ALICE };

  it("returns { ok: true, data: { due } } on success", async () => {
    serverImpl.tickSlicer.mockResolvedValue([{ sliceId: SLICE_A, sliceQty: 5 }]);
    const r = (await tickSlices({ data: valid })) as OkResult<{ due: unknown[] }>;
    expect(r.ok).toBe(true);
    expect(r.data.due).toHaveLength(1);
    expect(serverImpl.tickSlicer).toHaveBeenCalledWith(PF_ALICE, U_ALICE);
  });

  it("rejects a missing portfolioId at the validator", async () => {
    await expect(tickSlices({ data: {} as any })).rejects.toBeTruthy();
    expect(serverImpl.tickSlicer).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid portfolioId", async () => {
    await expect(tickSlices({ data: { portfolioId: "nope" } as any })).rejects.toBeTruthy();
  });

  it("maps ownership mismatches to a structured 403 response", async () => {
    serverImpl.tickSlicer.mockRejectedValue(new Error("ownership mismatch for portfolio"));
    const r = (await tickSlices({ data: valid })) as ErrResult;
    expect(r.error.code).toBe("ownership_mismatch");
    expect(statusCalls).toEqual([403]);
  });

  it("maps unknown throws to internal_error / 500", async () => {
    serverImpl.tickSlicer.mockRejectedValue(new Error("network wedged"));
    const r = (await tickSlices({ data: valid })) as ErrResult;
    expect(r.error.code).toBe("internal_error");
    expect(statusCalls).toEqual([500]);
  });
});

// ---- recordFill ------------------------------------------------------------
describe("recordFill", () => {
  const valid = { sliceId: SLICE_A, filledQty: 3, note: "partial" };

  it("returns { ok: true, data: { recorded: true } } on success", async () => {
    serverImpl.recordSliceFill.mockResolvedValue(undefined);
    const r = (await recordFill({ data: valid })) as OkResult<{ recorded: true }>;
    expect(r).toEqual({ ok: true, data: { recorded: true } });
    expect(serverImpl.recordSliceFill).toHaveBeenCalledWith(SLICE_A, U_ALICE, 3, "partial");
  });

  it("accepts filledQty=0 (NON_NEG) but rejects negative fills", async () => {
    serverImpl.recordSliceFill.mockResolvedValue(undefined);
    const zero = (await recordFill({ data: { ...valid, filledQty: 0 } })) as OkResult<unknown>;
    expect(zero.ok).toBe(true);
    await expect(recordFill({ data: { ...valid, filledQty: -1 } })).rejects.toBeTruthy();
  });

  it("rejects an over-length note", async () => {
    const bigNote = "x".repeat(501);
    await expect(recordFill({ data: { ...valid, note: bigNote } })).rejects.toBeTruthy();
    expect(serverImpl.recordSliceFill).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid sliceId", async () => {
    await expect(recordFill({ data: { ...valid, sliceId: "not-uuid" } })).rejects.toBeTruthy();
  });

  it("maps slice-not-found throws to { ok:false, code: not_found }", async () => {
    serverImpl.recordSliceFill.mockRejectedValue(new Error("slice lookup failed"));
    const r = (await recordFill({ data: valid })) as ErrResult;
    expect(r.error.code).toBe("not_found");
    expect(statusCalls).toEqual([404]);
  });

  it("maps ownership mismatches to 403", async () => {
    serverImpl.recordSliceFill.mockRejectedValue(new Error("ownership mismatch"));
    const r = (await recordFill({ data: valid })) as ErrResult;
    expect(r.error.code).toBe("ownership_mismatch");
    expect(statusCalls).toEqual([403]);
  });

  it("wraps unexpected throws as internal_error", async () => {
    serverImpl.recordSliceFill.mockRejectedValue(new Error("kaboom"));
    const r = (await recordFill({ data: valid })) as ErrResult;
    expect(r.error.code).toBe("internal_error");
    expect(statusCalls).toEqual([500]);
  });
});
