// Execution-quality metrics — how well the broker executed our orders.
//
// Reads three per-user tables (RLS-scoped via `OwnedDbClient`):
//   • live_orders     → submitted vs terminal status; limit_price reference
//   • live_fills      → realised fill_price, quantity, fee, filled_at
//   • pending_slices  → parent-slice plan (slice_count, slices_done, status)
//
// Metrics returned:
//   • Fill rate  — % of terminal orders that filled fully / partially,
//     split by side. Also raw order-status counts.
//   • Slippage   — side-aware bps vs limit_price for LIMIT orders that
//     produced at least one fill (buy: positive = paid more than limit;
//     sell: positive = received less than limit). Avg / median / p95.
//   • Slice adherence — completion rate, avg progress fraction, expired
//     count for parent slice programs. Split by side.
//
// SSR-serialisable DTOs only (arrays of plain objects, numbers, strings,
// null). Pure aggregation — no I/O beyond the initial reads.

import type { OwnedDbClient } from "@/lib/_server/owned-client";

type Side = "buy" | "sell";

export type FillRateBucket = {
  side: Side | "all";
  total: number;
  filled: number;
  partial: number;
  rejected: number;
  cancelled: number;
  pending: number;
  fillRatePct: number | null; // (filled + partial) / (total - pending)
  fullFillRatePct: number | null; // filled / (total - pending)
};

export type SlippageBucket = {
  side: Side | "all";
  samples: number;
  avgBps: number | null;
  medianBps: number | null;
  p95Bps: number | null;
  bestBps: number | null;
  worstBps: number | null;
};

export type SliceAdherenceBucket = {
  side: Side | "all";
  programs: number;
  filled: number;
  cancelled: number;
  expired: number;
  active: number;
  avgProgressPct: number | null; // mean(slices_done / slice_count)
  completionRatePct: number | null; // filled / programs
};

export type ExecutionQuality = {
  windowDays: number;
  since: string;
  totalOrders: number;
  totalFills: number;
  totalSlicePrograms: number;
  fillRate: FillRateBucket[];
  slippage: SlippageBucket[];
  slice: SliceAdherenceBucket[];
};

function pct(numer: number, denom: number): number | null {
  if (denom <= 0) return null;
  return (numer / denom) * 100;
}

function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function summariseSlippage(side: Side | "all", xs: number[]): SlippageBucket {
  return {
    side,
    samples: xs.length,
    avgBps: mean(xs),
    medianBps: percentile(xs, 0.5),
    p95Bps: percentile(xs, 0.95),
    bestBps: xs.length ? Math.min(...xs) : null,
    worstBps: xs.length ? Math.max(...xs) : null,
  };
}

function summariseFillRate(side: Side | "all", rows: OrderRow[]): FillRateBucket {
  const total = rows.length;
  let filled = 0, partial = 0, rejected = 0, cancelled = 0, pending = 0;
  for (const r of rows) {
    switch ((r.status ?? "").toLowerCase()) {
      case "filled": filled++; break;
      case "partial":
      case "partiallyfilled":
      case "partially_filled": partial++; break;
      case "rejected":
      case "error": rejected++; break;
      case "cancelled":
      case "canceled": cancelled++; break;
      default: pending++;
    }
  }
  const terminal = total - pending;
  return {
    side,
    total,
    filled,
    partial,
    rejected,
    cancelled,
    pending,
    fillRatePct: pct(filled + partial, terminal),
    fullFillRatePct: pct(filled, terminal),
  };
}

function summariseSlice(side: Side | "all", rows: SliceRow[]): SliceAdherenceBucket {
  let filled = 0, cancelled = 0, expired = 0, active = 0;
  const progress: number[] = [];
  for (const r of rows) {
    const status = (r.status ?? "").toLowerCase();
    if (status === "filled" || status === "completed") filled++;
    else if (status === "cancelled" || status === "canceled") cancelled++;
    else if (status === "expired") expired++;
    else active++;
    const count = Number(r.slice_count) || 0;
    const done = Number(r.slices_done) || 0;
    if (count > 0) progress.push(Math.max(0, Math.min(1, done / count)));
  }
  const meanProg = mean(progress);
  return {
    side,
    programs: rows.length,
    filled,
    cancelled,
    expired,
    active,
    avgProgressPct: meanProg == null ? null : meanProg * 100,
    completionRatePct: pct(filled, rows.length),
  };
}

type OrderRow = {
  id: string;
  side: string;
  status: string | null;
  limit_price: number | null;
  quantity: number;
  submitted_at: string | null;
};
type FillRow = {
  order_id: string;
  side: string;
  quantity: number;
  fill_price: number;
};
type SliceRow = {
  side: string;
  status: string | null;
  slice_count: number | null;
  slices_done: number | null;
};

export async function getExecutionQuality(
  portfolioId: string,
  windowDays: number,
  owned: OwnedDbClient,
): Promise<ExecutionQuality> {
  const db = owned.db;
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const [ordersRes, slicesRes] = await Promise.all([
    db
      .from("live_orders")
      .select("id, side, status, limit_price, quantity, submitted_at, created_at")
      .eq("portfolio_id", portfolioId)
      .gte("created_at", sinceIso),
    db
      .from("pending_slices")
      .select("side, status, slice_count, slices_done, created_at")
      .eq("portfolio_id", portfolioId)
      .gte("created_at", sinceIso),
  ]);
  if (ordersRes.error) throw new Error(ordersRes.error.message);
  if (slicesRes.error) throw new Error(slicesRes.error.message);

  const orders: OrderRow[] = (ordersRes.data ?? []).map((r) => ({
    id: r.id as string,
    side: (r.side as string) ?? "buy",
    status: (r.status as string) ?? null,
    limit_price: r.limit_price == null ? null : Number(r.limit_price),
    quantity: Number(r.quantity ?? 0),
    submitted_at: (r.submitted_at as string) ?? null,
  }));

  let fills: FillRow[] = [];
  if (orders.length > 0) {
    const ids = orders.map((o) => o.id);
    const fillRes = await db
      .from("live_fills")
      .select("order_id, side, quantity, fill_price")
      .in("order_id", ids);
    if (fillRes.error) throw new Error(fillRes.error.message);
    fills = (fillRes.data ?? []).map((r) => ({
      order_id: r.order_id as string,
      side: (r.side as string) ?? "buy",
      quantity: Number(r.quantity ?? 0),
      fill_price: Number(r.fill_price ?? 0),
    }));
  }

  // Aggregate fills per order → weighted-avg fill_price.
  const fillsByOrder = new Map<string, { qty: number; notional: number }>();
  for (const f of fills) {
    const cur = fillsByOrder.get(f.order_id) ?? { qty: 0, notional: 0 };
    cur.qty += f.quantity;
    cur.notional += f.quantity * f.fill_price;
    fillsByOrder.set(f.order_id, cur);
  }

  // Slippage bps for LIMIT orders that produced fills.
  const slipBuys: number[] = [];
  const slipSells: number[] = [];
  for (const o of orders) {
    if (o.limit_price == null || o.limit_price <= 0) continue;
    const agg = fillsByOrder.get(o.id);
    if (!agg || agg.qty <= 0) continue;
    const avgFill = agg.notional / agg.qty;
    const bps =
      o.side === "sell"
        ? ((o.limit_price - avgFill) / o.limit_price) * 10_000
        : ((avgFill - o.limit_price) / o.limit_price) * 10_000;
    if (!Number.isFinite(bps)) continue;
    (o.side === "sell" ? slipSells : slipBuys).push(bps);
  }

  const slices: SliceRow[] = (slicesRes.data ?? []).map((r) => ({
    side: (r.side as string) ?? "buy",
    status: (r.status as string) ?? null,
    slice_count: r.slice_count == null ? null : Number(r.slice_count),
    slices_done: r.slices_done == null ? null : Number(r.slices_done),
  }));

  const buys = orders.filter((o) => o.side === "buy");
  const sells = orders.filter((o) => o.side === "sell");
  const sliceBuys = slices.filter((s) => s.side === "buy");
  const sliceSells = slices.filter((s) => s.side === "sell");

  return {
    windowDays,
    since: sinceIso.slice(0, 10),
    totalOrders: orders.length,
    totalFills: fills.length,
    totalSlicePrograms: slices.length,
    fillRate: [
      summariseFillRate("all", orders),
      summariseFillRate("buy", buys),
      summariseFillRate("sell", sells),
    ],
    slippage: [
      summariseSlippage("all", [...slipBuys, ...slipSells]),
      summariseSlippage("buy", slipBuys),
      summariseSlippage("sell", slipSells),
    ],
    slice: [
      summariseSlice("all", slices),
      summariseSlice("buy", sliceBuys),
      summariseSlice("sell", sliceSells),
    ],
  };
}
