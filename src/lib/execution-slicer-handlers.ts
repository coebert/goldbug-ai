// Pure, non-RPC handler bodies for the execution-slicer server functions.
//
// The server-fn wrappers in `execution-slicer.functions.ts` are transformed
// by the TanStack Start Vite plugin into SSR RPC stubs at build time, which
// makes them impossible to invoke directly from a unit/integration test.
// Extracting the handler logic here keeps the wrappers tiny and gives us a
// plain async function per operation that:
//   - re-parses the payload with the canonical schema after injecting the
//     trusted userId (so a client cannot spoof `ownerUserId`),
//   - dynamically imports the underlying server helpers,
//   - and returns the structured `SlicerResult` discriminated union — never
//     a bare throw, so the RPC boundary always sees `{ ok, data|error }`.
//
// Tests can call these directly with a fabricated `userId`.
import { ZodError } from "zod";
import {
  SliceInputSchema,
  TickInputSchema,
  FillInputSchema,
} from "./execution-slicer-schemas";

export type ErrorCode =
  | "invalid_input"
  | "ownership_mismatch"
  | "not_found"
  | "internal_error";

export interface StructuredError {
  code: ErrorCode;
  message: string;
  issues?: Array<{ path: string; message: string }>;
}

export type SlicerResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: StructuredError };

export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_input: 400,
  ownership_mismatch: 403,
  not_found: 404,
  internal_error: 500,
};

// Injected by the server-fn wrapper so it can call setResponseStatus; in
// tests the recorder captures the emitted HTTP status.
export type StatusSetter = (code: number) => void;

function fail(
  setStatus: StatusSetter,
  code: ErrorCode,
  message: string,
  issues?: StructuredError["issues"],
): SlicerResult<never> {
  setStatus(STATUS_BY_CODE[code]);
  return { ok: false, error: { code, message, ...(issues ? { issues } : {}) } };
}

function zodIssues(err: ZodError): StructuredError["issues"] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

function classifyThrown(setStatus: StatusSetter, e: unknown): SlicerResult<never> {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ownership mismatch/i.test(msg)) {
    return fail(setStatus, "ownership_mismatch", "Portfolio or slice is not owned by the caller.");
  }
  if (/portfolio_not_found|slice lookup failed|not found/i.test(msg)) {
    return fail(setStatus, "not_found", msg);
  }
  if (/invalid input/i.test(msg)) return fail(setStatus, "invalid_input", msg);
  console.error("slicer server-fn failed", e);
  return fail(setStatus, "internal_error", "Slicer operation failed.");
}

// ---- enqueue ---------------------------------------------------------------

export async function enqueueSliceHandler(
  data: unknown,
  userId: string,
  setStatus: StatusSetter,
): Promise<
  SlicerResult<
    | { sliceId: string; sliceQty: number; slices: number }
    | { skipped: true; reason: "below_threshold" }
  >
> {
  const full = SliceInputSchema.safeParse({ ...(data as object), ownerUserId: userId });
  if (!full.success) return fail(setStatus, "invalid_input", "invalid enqueue input", zodIssues(full.error));

  try {
    const { maybeSliceOrder } = await import("./execution-slicer.server");
    const result = await maybeSliceOrder(full.data);
    if (result === null) return { ok: true, data: { skipped: true, reason: "below_threshold" } };
    return { ok: true, data: result };
  } catch (e) {
    if (e instanceof ZodError) return fail(setStatus, "invalid_input", "invalid enqueue input", zodIssues(e));
    return classifyThrown(setStatus, e);
  }
}

// ---- tick ------------------------------------------------------------------

export async function tickSlicesHandler(
  data: unknown,
  userId: string,
  setStatus: StatusSetter,
): Promise<SlicerResult<{ due: unknown }>> {
  const full = TickInputSchema.safeParse({ ...(data as object), ownerUserId: userId });
  if (!full.success) return fail(setStatus, "invalid_input", "invalid tick input", zodIssues(full.error));

  try {
    const { tickSlicer } = await import("./execution-slicer.server");
    const due = await tickSlicer(full.data.portfolioId, full.data.ownerUserId);
    return { ok: true, data: { due } };
  } catch (e) {
    if (e instanceof ZodError) return fail(setStatus, "invalid_input", "invalid tick input", zodIssues(e));
    return classifyThrown(setStatus, e);
  }
}

// ---- fill ------------------------------------------------------------------

export async function recordFillHandler(
  data: unknown,
  userId: string,
  setStatus: StatusSetter,
): Promise<SlicerResult<{ recorded: true }>> {
  const full = FillInputSchema.safeParse({ ...(data as object), ownerUserId: userId });
  if (!full.success) return fail(setStatus, "invalid_input", "invalid fill input", zodIssues(full.error));

  try {
    const { recordSliceFill } = await import("./execution-slicer.server");
    await recordSliceFill(full.data.sliceId, full.data.ownerUserId, full.data.filledQty, full.data.note);
    return { ok: true, data: { recorded: true } };
  } catch (e) {
    if (e instanceof ZodError) return fail(setStatus, "invalid_input", "invalid fill input", zodIssues(e));
    return classifyThrown(setStatus, e);
  }
}
