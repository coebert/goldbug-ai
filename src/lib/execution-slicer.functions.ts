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
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  SliceInputSchema,
  TickInputSchema,
  FillInputSchema,
} from "./execution-slicer-schemas";
import {
  enqueueSliceHandler,
  tickSlicesHandler,
  recordFillHandler,
  type SlicerResult,
} from "./execution-slicer-handlers";

export type { SlicerResult } from "./execution-slicer-handlers";

// Client-facing input schemas — server injects the trusted ownerUserId.
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
    return enqueueSliceHandler(data, context.userId, setResponseStatus);
  });

// ---- tick --------------------------------------------------------------

export const tickSlices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const parsed = TickClientSchema.safeParse(data);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  })
  .handler(async ({ data, context }) => {
    return tickSlicesHandler(data, context.userId, setResponseStatus);
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
    return recordFillHandler(data, context.userId, setResponseStatus);
  });

// Re-export the schemas so component code has one import for both the
// validator and the RPC call. Keeps client-side form validation in lockstep
// with the server contract.
export {
  SliceInputSchema,
  TickInputSchema,
  FillInputSchema,
} from "./execution-slicer-schemas";

