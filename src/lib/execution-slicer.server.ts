// TWAP-style order slicer. Large live orders are split across multiple hourly
// ticks. Each tick sends `slice_qty`; unfilled remainder expires after the TTL.
// Used only for live_prod routing. The kill-switch still forces live_sim → paper.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const DEFAULT_SLICE_TTL_MIN = 90; // 90 minutes total window
const DEFAULT_SLICES = 4;
const LARGE_ORDER_USD = 5_000;

export type SliceInput = {
  portfolioId: string;
  decisionId: string | null;
  symbol: string;
  side: "buy" | "sell";
  totalQty: number;
  priceHint: number;
  slices?: number;
  ttlMinutes?: number;
};

/**
 * Split a large order into slices. Small orders (< LARGE_ORDER_USD notional)
 * skip slicing and return `null` so caller can route immediately.
 */
export async function maybeSliceOrder(input: SliceInput) {
  const notional = input.totalQty * input.priceHint;
  if (notional < LARGE_ORDER_USD) return null;

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
 * slices that are due to send now (`next_at <= now`).
 */
export async function tickSlicer(portfolioId: string) {
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

export async function recordSliceFill(sliceId: string, filledQty: number, note?: string) {
  const { data } = await supabaseAdmin
    .from("pending_slices")
    .select("remaining_qty, slices_done, slice_count")
    .eq("id", sliceId)
    .single();
  if (!data) return;
  const remaining = Math.max(0, Number(data.remaining_qty) - filledQty);
  const done = Number(data.slices_done) + 1;
  const status = remaining <= 1e-6 || done >= Number(data.slice_count) ? "completed" : "active";
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
    .eq("id", sliceId);
}
