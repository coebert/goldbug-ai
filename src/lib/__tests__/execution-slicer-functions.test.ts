// Integration tests for the pure handler bodies backing the authenticated
// server-function wrappers in `execution-slicer.functions.ts`. Each RPC
// wrapper is a thin delegate around one of these handlers, so exercising
// them here covers the full validation → server-helper → response-shape
// path without going through the TanStack Start RPC transform (which the
// Vite plugin rewrites and would otherwise be unreachable from a unit
// test).
//
// We assert that every code path returns the discriminated-union response:
//   - `{ ok: true, data }` for successful and skipped operations
//   - `{ ok: false, error: { code, message, issues? } }` for schema
//     failures, ownership mismatches, missing rows, and unexpected throws
// and that the recorded HTTP status matches the error taxonomy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const U_ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PF_ALICE = "11111111-1111-4111-8111-111111111111";
const SLICE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DECISION_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// Per-test overrides of the underlying slicer helpers — the handlers reach
// them via `await import("./execution-slicer.server")`.
const serverImpl = {
  maybeSliceOrder: vi.fn<(input: unknown) => Promise<unknown>>(),
  tickSlicer: vi.fn<(portfolioId: string, userId: string) => Promise<unknown>>(),
  recordSliceFill: vi.fn<(sliceId: string, userId: string, qty: number, note?: string) => Promise<void>>(),
};
vi.mock("../execution-slicer.server", () => serverImpl);

import {
  enqueueSliceHandler,
  tickSlicesHandler,
  recordFillHandler,
} from "../execution-slicer-handlers";

type ErrResult = { ok: false; error: { code: string; message: string; issues?: Array<{ path: string; message: string }> } };
type OkResult<T> = { ok: true; data: T };

const statusCalls: number[] = [];
const setStatus = (code: number) => { statusCalls.push(code); };

beforeEach(() => {
  statusCalls.length = 0;
  serverImpl.maybeSliceOrder.mockReset();
  serverImpl.tickSlicer.mockReset();
  serverImpl.recordSliceFill.mockReset();
});
afterEach(() => vi.clearAllMocks());

// ---- enqueueSliceHandler --------------------------------------------------
describe("enqueueSliceHandler", () => {
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

  it("returns { ok: true, data } for a queued slice and injects the trusted userId", async () => {
    serverImpl.maybeSliceOrder.mockResolvedValue({ sliceId: SLICE_A, sliceQty: 10, slices: 4 });
    const r = (await enqueueSliceHandler(valid, U_ALICE, setStatus)) as OkResult<{ sliceId: string }>;
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ sliceId: SLICE_A, sliceQty: 10, slices: 4 });
    expect(serverImpl.maybeSliceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: U_ALICE, portfolioId: PF_ALICE }),
    );
    expect(statusCalls).toEqual([]);
  });

  it("ignores a client-supplied ownerUserId and uses the trusted context userId", async () => {
    serverImpl.maybeSliceOrder.mockResolvedValue({ sliceId: SLICE_A, sliceQty: 10, slices: 4 });
    const spoof = { ...valid, ownerUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    await enqueueSliceHandler(spoof, U_ALICE, setStatus);
    expect(serverImpl.maybeSliceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: U_ALICE }),
    );
  });

  it("returns { ok: true, data: { skipped } } when helper returns null (below threshold)", async () => {
    serverImpl.maybeSliceOrder.mockResolvedValue(null);
    const r = await enqueueSliceHandler(valid, U_ALICE, setStatus);
    expect(r).toEqual({ ok: true, data: { skipped: true, reason: "below_threshold" } });
  });

  it("rejects an invalid symbol with { ok:false, code: invalid_input } and status 400", async () => {
    const r = (await enqueueSliceHandler({ ...valid, symbol: "bad symbol!" }, U_ALICE, setStatus)) as ErrResult;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.issues?.[0]?.path).toBe("symbol");
    expect(statusCalls).toEqual([400]);
    expect(serverImpl.maybeSliceOrder).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid portfolioId at the schema boundary", async () => {
    const r = (await enqueueSliceHandler({ ...valid, portfolioId: "not-a-uuid" }, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.issues?.some((i) => i.path === "portfolioId")).toBe(true);
  });

  it("rejects negative quantities", async () => {
    const r = (await enqueueSliceHandler({ ...valid, totalQty: -5 }, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("invalid_input");
  });

  it("rejects slices outside [2, 8]", async () => {
    const r = (await enqueueSliceHandler({ ...valid, slices: 99 }, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("invalid_input");
  });

  it("maps ownership-mismatch throws to { ok:false, code: ownership_mismatch } / 403", async () => {
    serverImpl.maybeSliceOrder.mockRejectedValue(new Error("SECURITY:pending_slices ownership mismatch"));
    const r = (await enqueueSliceHandler(valid, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("ownership_mismatch");
    expect(statusCalls).toEqual([403]);
  });

  it("maps portfolio_not_found throws to { ok:false, code: not_found } / 404", async () => {
    serverImpl.maybeSliceOrder.mockRejectedValue(new Error("portfolio_not_found"));
    const r = (await enqueueSliceHandler(valid, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("not_found");
    expect(statusCalls).toEqual([404]);
  });

  it("classifies unknown throws as internal_error / 500", async () => {
    serverImpl.maybeSliceOrder.mockRejectedValue(new Error("db exploded"));
    const r = (await enqueueSliceHandler(valid, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("internal_error");
    expect(r.error.message).toMatch(/slicer/i);
    expect(statusCalls).toEqual([500]);
  });
});

// ---- tickSlicesHandler ----------------------------------------------------
describe("tickSlicesHandler", () => {
  const valid = { portfolioId: PF_ALICE };

  it("returns { ok: true, data: { due } } on success", async () => {
    serverImpl.tickSlicer.mockResolvedValue([{ id: SLICE_A, symbol: "AAPL", side: "buy", slice_qty: 5, remaining_qty: 5, slices_done: 0, slice_count: 4, limit_price: null, expires_at: new Date().toISOString() }]);
    const r = (await tickSlicesHandler(valid, U_ALICE, setStatus)) as OkResult<{ due: unknown[] }>;
    expect(r.ok).toBe(true);
    expect(r.data.due).toHaveLength(1);
    expect(serverImpl.tickSlicer).toHaveBeenCalledWith(PF_ALICE, U_ALICE);
  });

  it("rejects a missing portfolioId as invalid_input / 400", async () => {
    const r = (await tickSlicesHandler({}, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("invalid_input");
    expect(statusCalls).toEqual([400]);
    expect(serverImpl.tickSlicer).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid portfolioId", async () => {
    const r = (await tickSlicesHandler({ portfolioId: "nope" }, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("invalid_input");
  });

  it("maps ownership mismatches to a structured 403", async () => {
    serverImpl.tickSlicer.mockRejectedValue(new Error("ownership mismatch for portfolio"));
    const r = (await tickSlicesHandler(valid, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("ownership_mismatch");
    expect(statusCalls).toEqual([403]);
  });

  it("maps unknown throws to internal_error / 500", async () => {
    serverImpl.tickSlicer.mockRejectedValue(new Error("network wedged"));
    const r = (await tickSlicesHandler(valid, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("internal_error");
    expect(statusCalls).toEqual([500]);
  });
});

// ---- recordFillHandler ----------------------------------------------------
describe("recordFillHandler", () => {
  const valid = { sliceId: SLICE_A, filledQty: 3, note: "partial" };

  it("returns { ok: true, data: { recorded: true } } on success", async () => {
    serverImpl.recordSliceFill.mockResolvedValue(undefined);
    const r = (await recordFillHandler(valid, U_ALICE, setStatus)) as OkResult<{ recorded: true }>;
    expect(r).toEqual({ ok: true, data: { recorded: true } });
    expect(serverImpl.recordSliceFill).toHaveBeenCalledWith(SLICE_A, U_ALICE, 3, "partial");
  });

  it("accepts filledQty=0 (NON_NEG) but rejects negative fills", async () => {
    serverImpl.recordSliceFill.mockResolvedValue(undefined);
    const zero = (await recordFillHandler({ ...valid, filledQty: 0 }, U_ALICE, setStatus)) as OkResult<unknown>;
    expect(zero.ok).toBe(true);

    const neg = (await recordFillHandler({ ...valid, filledQty: -1 }, U_ALICE, setStatus)) as ErrResult;
    expect(neg.error.code).toBe("invalid_input");
  });

  it("rejects an over-length note", async () => {
    const bigNote = "x".repeat(501);
    const r = (await recordFillHandler({ ...valid, note: bigNote }, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("invalid_input");
    expect(serverImpl.recordSliceFill).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid sliceId", async () => {
    const r = (await recordFillHandler({ ...valid, sliceId: "not-uuid" }, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.issues?.some((i) => i.path === "sliceId")).toBe(true);
  });

  it("maps slice-not-found throws to { ok:false, code: not_found } / 404", async () => {
    serverImpl.recordSliceFill.mockRejectedValue(new Error("slice lookup failed"));
    const r = (await recordFillHandler(valid, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("not_found");
    expect(statusCalls).toEqual([404]);
  });

  it("maps ownership mismatches to 403", async () => {
    serverImpl.recordSliceFill.mockRejectedValue(new Error("ownership mismatch"));
    const r = (await recordFillHandler(valid, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("ownership_mismatch");
    expect(statusCalls).toEqual([403]);
  });

  it("wraps unexpected throws as internal_error / 500", async () => {
    serverImpl.recordSliceFill.mockRejectedValue(new Error("kaboom"));
    const r = (await recordFillHandler(valid, U_ALICE, setStatus)) as ErrResult;
    expect(r.error.code).toBe("internal_error");
    expect(statusCalls).toEqual([500]);
  });
});

// ---- idempotency ----------------------------------------------------------
describe("idempotency keys", () => {
  const enqueueValid = {
    portfolioId: PF_ALICE,
    decisionId: DECISION_A,
    symbol: "AAPL",
    side: "buy" as const,
    totalQty: 40,
    priceHint: 190.5,
    slices: 4,
    ttlMinutes: 60,
    idempotencyKey: "dec-2026-01-15-aapl-buy",
  };

  it("forwards idempotencyKey through enqueueSliceHandler and returns { reused } on repeat", async () => {
    // First call inserts a fresh slice.
    serverImpl.maybeSliceOrder.mockResolvedValueOnce({ sliceId: SLICE_A, sliceQty: 10, slices: 4 });
    // Second call with the same key returns the existing row.
    serverImpl.maybeSliceOrder.mockResolvedValueOnce({ sliceId: SLICE_A, sliceQty: 10, slices: 4, reused: true });

    const first = (await enqueueSliceHandler(enqueueValid, U_ALICE, setStatus)) as OkResult<{ sliceId: string; reused?: true }>;
    const second = (await enqueueSliceHandler(enqueueValid, U_ALICE, setStatus)) as OkResult<{ sliceId: string; reused?: true }>;

    expect(first.data.sliceId).toBe(SLICE_A);
    expect(first.data.reused).toBeUndefined();
    expect(second.data.sliceId).toBe(SLICE_A);
    expect(second.data.reused).toBe(true);
    expect(serverImpl.maybeSliceOrder).toHaveBeenCalledTimes(2);
    for (const call of serverImpl.maybeSliceOrder.mock.calls) {
      expect(call[0]).toMatchObject({ idempotencyKey: "dec-2026-01-15-aapl-buy" });
    }
    expect(statusCalls).toEqual([]);
  });

  it("rejects a too-short idempotencyKey at the schema boundary", async () => {
    const r = (await enqueueSliceHandler({ ...enqueueValid, idempotencyKey: "abc" }, U_ALICE, setStatus)) as ErrResult;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.issues?.[0]?.path).toBe("idempotencyKey");
    expect(serverImpl.maybeSliceOrder).not.toHaveBeenCalled();
    expect(statusCalls).toEqual([400]);
  });

  it("forwards idempotencyKey through recordFillHandler and flags duplicates as ok + duplicate", async () => {
    const fillValid = {
      sliceId: SLICE_A,
      filledQty: 10,
      idempotencyKey: "fill-2026-01-15-aapl-t1",
    };
    // First fill applies.
    serverImpl.recordSliceFill.mockResolvedValueOnce({ applied: true } as never);
    // Second fill is a duplicate.
    serverImpl.recordSliceFill.mockResolvedValueOnce({ applied: false, reason: "duplicate" } as never);

    const first = (await recordFillHandler(fillValid, U_ALICE, setStatus)) as OkResult<{ recorded: true; duplicate?: boolean }>;
    const second = (await recordFillHandler(fillValid, U_ALICE, setStatus)) as OkResult<{ recorded: true; duplicate?: boolean }>;

    expect(first.data).toEqual({ recorded: true });
    expect(second.data).toEqual({ recorded: true, duplicate: true });
    for (const call of serverImpl.recordSliceFill.mock.calls) {
      expect(call[4]).toBe("fill-2026-01-15-aapl-t1");
    }
    expect(statusCalls).toEqual([]);
  });

  it("rejects an idempotencyKey with disallowed characters", async () => {
    const r = (await recordFillHandler(
      { sliceId: SLICE_A, filledQty: 10, idempotencyKey: "bad key with spaces!" },
      U_ALICE,
      setStatus,
    )) as ErrResult;
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.issues?.[0]?.path).toBe("idempotencyKey");
    expect(serverImpl.recordSliceFill).not.toHaveBeenCalled();
    expect(statusCalls).toEqual([400]);
  });
});

