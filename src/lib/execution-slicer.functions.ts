// Authenticated server-function wrappers for the TWAP execution slicer.
//
// These are the ONLY public entry points for enqueue / tick / fill from the
// browser. Every call:
//   1. Runs through `requireSupabaseAuth` so an authenticated Supabase JWT is
//      required and `context.userId` is trusted server-side.
//   2. Re-parses its payload with the same client-safe Zod schemas exported
//      from `execution-slicer-schemas` (`SliceInputSchema`, `TickInputSchema`,
//      `FillInputSchema`). The caller-supplied `ownerUserId` is ignored and
//      overwritten with `context.userId` before validation, so a client
//      cannot spoof another user's id past the schema.
//   3. Returns a structured discriminated-union response — never a bare throw
//      across the RPC boundary. Clients pattern-match on `result.ok`.
//
// Ownership + logging is still enforced inside the underlying `.server`
// helpers (`assertPortfolioOwnership`, `logUnexpectedAccess`). This module is
// a hardening layer around them, not a replacement.

import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { z, ZodError } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  SliceInputSchema,
  TickInputSchema,
  FillInputSchema,
} from "./execution-slicer-schemas";

// ---- Response shape ----------------------------------------------------

type ErrorCode =
  | "invalid_input"
  | "ownership_mismatch"
  | "not_found"
  | "internal_error";

type StructuredError = {
  code: ErrorCode;
  message: string;
  issues?: Array<{ path: string; message: string }>;
};

export type SlicerResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: StructuredError };

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_input: 400,
  ownership_mismatch: 403,
  not_found: 404,
  internal_error: 500,
};

function fail(code: ErrorCode, message: string, issues?: StructuredError["issues"]): SlicerResult<never> {
  setResponseStatus(STATUS_BY_CODE[code]);
  return { ok: false, error: { code, message, ...(issues ? { issues } : {}) } };
}

function zodIssues(err: ZodError): StructuredError["issues"] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

function classifyThrown(e: unknown): SlicerResult<never> {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ownership mismatch/i.test(msg)) return fail("ownership_mismatch", "Portfolio or slice is not owned by the caller.");
  if (/portfolio_not_found|slice lookup failed|not found/i.test(msg)) return fail("not_found", msg);
  if (/invalid input/i.test(msg)) return fail("invalid_input", msg);
  console.error("slicer server-fn failed", e);
  return fail("internal_error", "Slicer operation failed.");
}

// ---- Client-facing input schemas (ownerUserId stripped) ----------------
//
// The schemas from `execution-slicer-schemas` require `ownerUserId` because
// the server helpers must know which user to attribute the call to. Over the
// wire we drop it — the server injects the authenticated user id instead.

const EnqueueClientSchema = SliceInputSchema.omit({ ownerUserId: true });
const TickClientSchema = TickInputSchema.omit({ ownerUserId: true });
const FillClientSchema = FillInputSchema.omit({ ownerUserId: true });

// ---- enqueue -----------------------------------------------------------

export const enqueueSlice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const parsed = EnqueueClientSchema.safeParse(data);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  })
  .handler(async ({ data, context }): Promise<SlicerResult<{
    sliceId: string; sliceQty: number; slices: number;
  } | { skipped: true; reason: "below_threshold" }>> => {
    // Re-validate with the canonical schema after injecting the trusted
    // ownerUserId — protects against schema drift between client/server.
    const full = SliceInputSchema.safeParse({ ...data, ownerUserId: context.userId });
    if (!full.success) return fail("invalid_input", "invalid enqueue input", zodIssues(full.error));

    try {
      const { maybeSliceOrder } = await import("./execution-slicer.server");
      const result = await maybeSliceOrder(full.data);
      if (result === null) return { ok: true, data: { skipped: true, reason: "below_threshold" } };
      return { ok: true, data: result };
    } catch (e) {
      if (e instanceof ZodError) return fail("invalid_input", "invalid enqueue input", zodIssues(e));
      return classifyThrown(e);
    }
  });

// ---- tick --------------------------------------------------------------

export const tickSlices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const parsed = TickClientSchema.safeParse(data);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  })
  .handler(async ({ data, context }): Promise<SlicerResult<{ due: Array<Record<string, unknown>> }>> => {
    const full = TickInputSchema.safeParse({ ...data, ownerUserId: context.userId });
    if (!full.success) return fail("invalid_input", "invalid tick input", zodIssues(full.error));

    try {
      const { tickSlicer } = await import("./execution-slicer.server");
      const due = await tickSlicer(full.data.portfolioId, full.data.ownerUserId);
      return { ok: true, data: { due } };
    } catch (e) {
      if (e instanceof ZodError) return fail("invalid_input", "invalid tick input", zodIssues(e));
      return classifyThrown(e);
    }
  });

// ---- fill --------------------------------------------------------------

export const recordFill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const parsed = FillClientSchema.safeParse(data);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  })
  .handler(async ({ data, context }): Promise<SlicerResult<{ recorded: true }>> => {
    const full = FillInputSchema.safeParse({ ...data, ownerUserId: context.userId });
    if (!full.success) return fail("invalid_input", "invalid fill input", zodIssues(full.error));

    try {
      const { recordSliceFill } = await import("./execution-slicer.server");
      await recordSliceFill(full.data.sliceId, full.data.ownerUserId, full.data.filledQty, full.data.note);
      return { ok: true, data: { recorded: true } };
    } catch (e) {
      if (e instanceof ZodError) return fail("invalid_input", "invalid fill input", zodIssues(e));
      return classifyThrown(e);
    }
  });

// Re-export the schemas so component code has one import for both the
// validator and the RPC call. Keeps client-side form validation in lockstep
// with the server contract.
export {
  SliceInputSchema,
  TickInputSchema,
  FillInputSchema,
} from "./execution-slicer-schemas";

// Alias to match the ZodError type-only import in typecheck-strict envs.
export type { z };
