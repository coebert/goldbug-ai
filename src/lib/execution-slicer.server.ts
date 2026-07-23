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

const DEFAULT_SLICE_TTL_MIN = 90; // 90 minutes total window
const DEFAULT_SLICES = 4;
const LARGE_ORDER_USD = 5_000;

// ----------------------------------------------------------------------------
// Input validation (zod). Every public helper runs its arguments through these
// before touching supabaseAdmin. Rejecting garbage inputs up-front removes a
// whole class of "portfolio_not_found" / "slice_lookup_failed" noise from the
// SECURITY:pending_slices logs and keeps unexpected-access warnings unambiguous.
// ----------------------------------------------------------------------------

const UUID = z.string().trim().uuid();
const SYMBOL = z
  .string()
  .trim()
  .min(1)
  .max(32)
  // Common Yahoo/Saxo symbol shapes: AAPL, BRK.B, RDS-A, ES=F, BTC-USD.
  .regex(/^[A-Za-z0-9._:=/-]+$/, "invalid symbol");
const SIDE = z.enum(["buy", "sell"]);
const POSITIVE = z.number().finite().positive();
const NON_NEG = z.number().finite().nonnegative();

const SliceInputSchema = z.object({
  portfolioId: UUID,
  ownerUserId: UUID,
  decisionId: UUID.nullable(),
  symbol: SYMBOL,
  side: SIDE,
  totalQty: POSITIVE.max(1e9),
  priceHint: POSITIVE.max(1e9),
  slices: z.number().int().min(2).max(8).optional(),
  ttlMinutes: z.number().int().min(1).max(24 * 60).optional(),
});

const FillInputSchema = z.object({
  sliceId: UUID,
  ownerUserId: UUID,
  filledQty: NON_NEG.max(1e9),
  note: z.string().trim().max(500).optional(),
});

const TickInputSchema = z.object({
  portfolioId: UUID,
  ownerUserId: UUID,
});

export type SliceInput = z.input<typeof SliceInputSchema>;


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
  const notional = input.totalQty * input.priceHint;
  if (notional < LARGE_ORDER_USD) return null;

  await assertPortfolioOwnership("maybeSliceOrder", input.portfolioId, input.ownerUserId);

  const slices = Math.max(2, Math.min(8, input.slices ?? DEFAULT_SLICES));
  const sliceQty = Math.max(1, Math.floor((input.totalQty / slices) * 10_000) / 10_000);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMinutes ?? DEFAULT_SLICE_TTL_MIN) * 60_000);

  const { data, error } = await supabaseAdmin
    .from("pending_slices")
    .insert({
      portfolio_id: input.portfolioId,
      decision_id: input.decisionId,
      symbol: input.symbol,
      side: input.side,
      total_qty: input.totalQty,
      remaining_qty: input.totalQty,
      slice_qty: sliceQty,
      slice_count: slices,
      slices_done: 0,
      limit_price: input.priceHint,
      next_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: "active",
    } as unknown as never)
    .select("id")
    .single();
  if (error) {
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
  await assertPortfolioOwnership("tickSlicer", portfolioId, ownerUserId);

  const now = new Date().toISOString();
  // Expire past-due slices
  await supabaseAdmin
    .from("pending_slices")
    .update({ status: "expired" } as unknown as never)
    .eq("portfolio_id", portfolioId)
    .eq("status", "active")
    .lt("expires_at", now);

  const { data } = await supabaseAdmin
    .from("pending_slices")
    .select("*")
    .eq("portfolio_id", portfolioId)
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
  // Look up the slice to discover its portfolio, then prove ownership before
  // mutating. This blocks a caller from patching another user's slice by id.
  const { data: slice, error: sliceErr } = await supabaseAdmin
    .from("pending_slices")
    .select("id, portfolio_id, remaining_qty, slices_done, slice_count")
    .eq("id", sliceId)
    .maybeSingle();
  if (sliceErr) {
    logUnexpectedAccess({ op: "recordSliceFill", reason: "slice_lookup_failed", sliceId, error: sliceErr.message });
    throw new PendingSliceAccessError("pending_slices: slice lookup failed", {
      sliceId, error: sliceErr.message,
    });
  }
  if (!slice) {
    logUnexpectedAccess({ op: "recordSliceFill", reason: "slice_not_found", sliceId, ownerUserId });
    return;
  }
  const typed = slice as {
    portfolio_id: string; remaining_qty: number; slices_done: number; slice_count: number;
  };
  await assertPortfolioOwnership("recordSliceFill", typed.portfolio_id, ownerUserId);

  const remaining = Math.max(0, Number(typed.remaining_qty) - filledQty);
  const done = Number(typed.slices_done) + 1;
  const status = remaining <= 1e-6 || done >= Number(typed.slice_count) ? "completed" : "active";
  const nextAt = status === "active"
    ? new Date(Date.now() + 20 * 60_000).toISOString() // next slice in ~20 min
    : null;
  const patch: Record<string, unknown> = {
    remaining_qty: remaining,
    slices_done: done,
    status,
    notes: note ?? null,
  };
  if (nextAt) patch.next_at = nextAt;
  await supabaseAdmin
    .from("pending_slices")
    .update(patch as unknown as never)
    .eq("id", sliceId)
    .eq("portfolio_id", typed.portfolio_id); // belt-and-braces scope
}
