// TWAP-style order slicer. Large live orders are split across multiple hourly
// ticks. Each tick sends `slice_qty`; unfilled remainder expires after the TTL.
// Used only for live_prod routing. The kill-switch still forces live_sim → paper.
//
// SECURITY: pending_slices carries per-portfolio order intent (symbol, side,
// qty, limit price). RLS on the table restricts SELECT to the portfolio
// owner, but every function here uses `supabaseAdmin`, which bypasses RLS
// entirely. Each function must therefore prove ownership itself and log a
// structured warning whenever a caller tries to touch a slice/portfolio it
// does not own. Never expose these helpers to unauthenticated code paths.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";
import {
  SliceInputSchema,
  FillInputSchema,
  TickInputSchema,
  type SliceInput,
} from "./execution-slicer-schemas";

// Re-export the client-safe schemas so existing server-side importers keep
// working. The canonical definitions live in `execution-slicer-schemas.ts`
// (client-safe) — see that file for the full validation contract.
export {
  SliceInputSchema,
  FillInputSchema,
  TickInputSchema,
  UUID,
  SYMBOL,
  SIDE,
  POSITIVE,
  NON_NEG,
  SLICE_COUNT,
  TTL_MINUTES,
} from "./execution-slicer-schemas";
export type { SliceInput, FillInput, TickInput } from "./execution-slicer-schemas";

const DEFAULT_SLICE_TTL_MIN = 90; // 90 minutes total window
const DEFAULT_SLICES = 4;
const LARGE_ORDER_USD = 5_000;



class PendingSliceAccessError extends Error {
  constructor(message: string, public readonly context: Record<string, unknown>) {
    super(message);
    this.name = "PendingSliceAccessError";
  }
}

function logUnexpectedAccess(context: Record<string, unknown>) {
  // Structured, greppable log line — surfaces in edge function logs.
  console.warn(
    "SECURITY:pending_slices unexpected access attempt",
    JSON.stringify({ at: new Date().toISOString(), ...context }),
  );
  // Fire-and-forget persistence to the security audit log so admins can
  // review the event via the UI. We never await this and never let a
  // persistence failure mask the original access-control decision.
  void (async () => {
    try {
      const op = typeof context.op === "string" ? context.op : null;
      const reason = typeof context.reason === "string" ? context.reason : null;
      const portfolioId = typeof context.portfolioId === "string" ? context.portfolioId : null;
      const sliceId = typeof context.sliceId === "string" ? context.sliceId : null;
      const actor = typeof context.ownerUserId === "string" ? context.ownerUserId : null;
      await supabaseAdmin.from("security_audit_log").insert({
        event: "pending_slices",
        op,
        reason,
        portfolio_id: portfolioId,
        slice_id: sliceId,
        actor_user_id: actor,
        details: JSON.parse(JSON.stringify(context)),
      });
      // Threshold-based notifications (push). Never let a notify failure
      // mask the original security signal.
      const { maybeNotifySecurityEvent } = await import("@/lib/security-alerts.server");
      maybeNotifySecurityEvent({
        actorUserId: actor,
        event: "pending_slices",
        reason,
        portfolioId,
      });
    } catch (e) {
      console.warn(
        "SECURITY:pending_slices audit persist failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  })();
}



/**
 * Run `input` through `schema` and throw a `PendingSliceAccessError` with a
 * `validation_failed` warning on any issue. Keeps unexpected-access logs
 * unambiguous: malformed inputs never reach the DB lookup layer.
 */
function validate<T>(op: string, schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      code: i.code,
      message: i.message,
    }));
    logUnexpectedAccess({ op, reason: "validation_failed", issues });
    throw new PendingSliceAccessError(`pending_slices: invalid input for ${op}`, { op, issues });
  }
  return parsed.data;
}


async function assertPortfolioOwnership(
  op: string,
  portfolioId: string,
  ownerUserId: string,
): Promise<void> {
  if (!portfolioId || !ownerUserId) {
    logUnexpectedAccess({ op, reason: "missing_ids", portfolioId, ownerUserId });
    throw new PendingSliceAccessError("pending_slices: missing portfolioId or ownerUserId", {
      op, portfolioId, ownerUserId,
    });
  }
  const { data, error } = await supabaseAdmin
    .from("portfolios")
    .select("id, user_id")
    .eq("id", portfolioId)
    .maybeSingle();
  if (error) {
    logUnexpectedAccess({ op, reason: "portfolio_lookup_failed", portfolioId, error: error.message });
    throw new PendingSliceAccessError("pending_slices: portfolio lookup failed", {
      op, portfolioId, error: error.message,
    });
  }
  if (!data) {
    logUnexpectedAccess({ op, reason: "portfolio_not_found", portfolioId, ownerUserId });
    throw new PendingSliceAccessError("pending_slices: portfolio not found", { op, portfolioId });
  }
  if ((data as { user_id: string }).user_id !== ownerUserId) {
    logUnexpectedAccess({
      op,
      reason: "ownership_mismatch",
      portfolioId,
      expectedOwner: ownerUserId,
      actualOwner: (data as { user_id: string }).user_id,
    });
    throw new PendingSliceAccessError("pending_slices: ownership mismatch", {
      op, portfolioId, expectedOwner: ownerUserId,
    });
  }
}

/**
 * Split a large order into slices. Small orders (< LARGE_ORDER_USD notional)
 * skip slicing and return `null` so caller can route immediately.
 */
export async function maybeSliceOrder(input: SliceInput) {
  const clean = validate("maybeSliceOrder", SliceInputSchema, input);
  const notional = clean.totalQty * clean.priceHint;
  if (notional < LARGE_ORDER_USD) return null;

  await assertPortfolioOwnership("maybeSliceOrder", clean.portfolioId, clean.ownerUserId);

  const slices = clean.slices ?? DEFAULT_SLICES;
  const sliceQty = Math.max(1, Math.floor((clean.totalQty / slices) * 10_000) / 10_000);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (clean.ttlMinutes ?? DEFAULT_SLICE_TTL_MIN) * 60_000);

  // Idempotency: if a slice with this (portfolio_id, idempotency_key) already
  // exists, return it instead of inserting a duplicate row.
  if (clean.idempotencyKey) {
    const { data: existing } = await supabaseAdmin
      .from("pending_slices")
      .select("id, slice_qty, slice_count")
      .eq("portfolio_id", clean.portfolioId)
      .eq("idempotency_key", clean.idempotencyKey)
      .maybeSingle();
    if (existing) {
      const row = existing as { id: string; slice_qty: number; slice_count: number };
      return { sliceId: row.id, sliceQty: Number(row.slice_qty), slices: Number(row.slice_count), reused: true as const };
    }
  }

  const { data, error } = await supabaseAdmin
    .from("pending_slices")
    .insert({
      portfolio_id: clean.portfolioId,
      decision_id: clean.decisionId,
      symbol: clean.symbol,
      side: clean.side,
      total_qty: clean.totalQty,
      remaining_qty: clean.totalQty,
      slice_qty: sliceQty,
      slice_count: slices,
      slices_done: 0,
      limit_price: clean.priceHint,
      next_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: "active",
      idempotency_key: clean.idempotencyKey ?? null,
    } as unknown as never)
    .select("id")
    .single();
  if (error) {
    // Unique-violation race: another concurrent request enqueued the same
    // idempotency key between our lookup and insert. Re-read and return it.
    if (clean.idempotencyKey && /duplicate key|unique/i.test(error.message ?? "")) {
      const { data: raced } = await supabaseAdmin
        .from("pending_slices")
        .select("id, slice_qty, slice_count")
        .eq("portfolio_id", clean.portfolioId)
        .eq("idempotency_key", clean.idempotencyKey)
        .maybeSingle();
      if (raced) {
        const row = raced as { id: string; slice_qty: number; slice_count: number };
        return { sliceId: row.id, sliceQty: Number(row.slice_qty), slices: Number(row.slice_count), reused: true as const };
      }
    }
    console.warn("slicer insert failed", error);
    return null;
  }
  return { sliceId: (data as { id: string }).id, sliceQty, slices };
}


/**
 * Called at the top of each hourly cron. Marks expired slices, returns active
 * slices that are due to send now (`next_at <= now`). Caller must supply the
 * authenticated user id owning `portfolioId`.
 */
export async function tickSlicer(portfolioId: string, ownerUserId: string) {
  const clean = validate("tickSlicer", TickInputSchema, { portfolioId, ownerUserId });
  await assertPortfolioOwnership("tickSlicer", clean.portfolioId, clean.ownerUserId);

  const now = new Date().toISOString();
  // Expire past-due slices
  await supabaseAdmin
    .from("pending_slices")
    .update({ status: "expired" } as unknown as never)
    .eq("portfolio_id", clean.portfolioId)
    .eq("status", "active")
    .lt("expires_at", now);

  const { data } = await supabaseAdmin
    .from("pending_slices")
    .select("*")
    .eq("portfolio_id", clean.portfolioId)
    .eq("status", "active")
    .lte("next_at", now)
    .order("next_at", { ascending: true });
  return (data ?? []) as Array<{
    id: string; symbol: string; side: string; slice_qty: number; remaining_qty: number;
    slices_done: number; slice_count: number; limit_price: number | null; expires_at: string;
  }>;
}

export async function recordSliceFill(
  sliceId: string,
  ownerUserId: string,
  filledQty: number,
  note?: string,
) {
  const clean = validate("recordSliceFill", FillInputSchema, {
    sliceId, ownerUserId, filledQty, note,
  });
  // Look up the slice to discover its portfolio, then prove ownership before
  // mutating. This blocks a caller from patching another user's slice by id.
  const { data: slice, error: sliceErr } = await supabaseAdmin
    .from("pending_slices")
    .select("id, portfolio_id, remaining_qty, slices_done, slice_count")
    .eq("id", clean.sliceId)
    .maybeSingle();
  if (sliceErr) {
    logUnexpectedAccess({ op: "recordSliceFill", reason: "slice_lookup_failed", sliceId: clean.sliceId, error: sliceErr.message });
    throw new PendingSliceAccessError("pending_slices: slice lookup failed", {
      sliceId: clean.sliceId, error: sliceErr.message,
    });
  }
  if (!slice) {
    logUnexpectedAccess({ op: "recordSliceFill", reason: "slice_not_found", sliceId: clean.sliceId, ownerUserId: clean.ownerUserId });
    return;
  }
  const typed = slice as {
    portfolio_id: string; remaining_qty: number; slices_done: number; slice_count: number;
  };
  await assertPortfolioOwnership("recordSliceFill", typed.portfolio_id, clean.ownerUserId);


  const remaining = Math.max(0, Number(typed.remaining_qty) - clean.filledQty);
  const done = Number(typed.slices_done) + 1;
  const status = remaining <= 1e-6 || done >= Number(typed.slice_count) ? "completed" : "active";
  const nextAt = status === "active"
    ? new Date(Date.now() + 20 * 60_000).toISOString() // next slice in ~20 min
    : null;
  const patch: Record<string, unknown> = {
    remaining_qty: remaining,
    slices_done: done,
    status,
    notes: clean.note ?? null,
  };
  if (nextAt) patch.next_at = nextAt;
  await supabaseAdmin
    .from("pending_slices")
    .update(patch as unknown as never)
    .eq("id", clean.sliceId)
    .eq("portfolio_id", typed.portfolio_id); // belt-and-braces scope
}
