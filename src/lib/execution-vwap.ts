// VWAP / TWAP smart order-slicing math.
//
// Pure, deterministic helpers with no I/O — safe to import from client or
// server. The server-side slicer (`execution-slicer.server.ts`) uses these
// to decide how many child orders to send, how much quantity each carries,
// how many minutes to wait between them, and what limit price to post.
//
// Why VWAP over TWAP: intraday volume follows a well-documented U-shape —
// heavy at the open, thin at midday, heavy into the close. Matching child
// slice sizes to that curve keeps our footprint closer to the natural
// tape, which reduces adverse selection (and therefore slippage) versus a
// naive constant-size TWAP.

export type SliceStrategy = "twap" | "vwap" | "immediate";

export type ScheduleBucket = {
  qty: number;
  offset_min: number; // minutes from slice-start to send this bucket
};

// ---------------------------------------------------------------------------
// Guardrails
//
// Every input below can arrive from a persisted row, a broker hint, or a
// caller that skipped schema validation. Unbounded or non-finite values used
// to produce enormous arrays (`nSlices = 1e9`), NaN quantities that poisoned
// every downstream comparison, or lot sizes so small that the residual loop
// churned — all of which showed up as a hung slicer tick rather than a clean
// failure. These caps make the math total: bounded work, finite output, for
// any input at all.
// ---------------------------------------------------------------------------

/** Hard ceiling on child orders in one schedule. */
export const MAX_SLICES = 32;
/** Hard ceiling on the wall-clock horizon (7 days). */
export const MAX_WINDOW_MINUTES = 7 * 24 * 60;
/** Smallest tradable increment we will ever plan against. */
export const MIN_LOT = 1e-6;

/** Coerce anything to a finite number inside [min, max], else `fallback`. */
function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalize a requested slice count into [1, MAX_SLICES]. */
export function normalizeSliceCount(nSlices: unknown): number {
  return Math.floor(clampFinite(nSlices, 1, MAX_SLICES, 1));
}

// Classic U-shape intraday volume weights, roughly matching S&P 500
// tape studies (Almgren & Chriss, 2000). We build the weights on the fly
// from a two-hump curve so this scales to any bucket count.
export function vwapWeights(nSlices: number): number[] {
  const n = Math.max(2, normalizeSliceCount(nSlices));
  const raw = Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n; // bucket midpoint in [0,1]
    // Two Gaussians centred near open (t=0.1) and close (t=0.95),
    // plus a small constant floor so midday slices are never zero.
    const openHump = Math.exp(-((t - 0.10) ** 2) / (2 * 0.08 ** 2));
    const closeHump = 1.35 * Math.exp(-((t - 0.95) ** 2) / (2 * 0.08 ** 2));
    return 0.35 + openHump + closeHump;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !Number.isFinite(total)) return Array.from({ length: n }, () => 1 / n);
  return raw.map((w) => w / total);
}

export function twapWeights(nSlices: number): number[] {
  const n = Math.max(2, normalizeSliceCount(nSlices));
  return Array.from({ length: n }, () => 1 / n);
}

// Pick a sensible number of child orders. The core heuristic is
// "participation rate" — never plan to consume more than ~15% of an
// average day's volume in a single tranche.
export function chooseSliceCount(
  orderNotional: number,
  advNotional: number | null | undefined,
  opts: { minSlices?: number; maxSlices?: number; targetParticipation?: number } = {},
): number {
  const min = Math.floor(clampFinite(opts.minSlices, 1, MAX_SLICES, 2));
  const max = Math.max(min, Math.floor(clampFinite(opts.maxSlices, 1, MAX_SLICES, 8)));
  const participation = clampFinite(opts.targetParticipation, 1e-4, 1, 0.15);
  const adv = Number(advNotional);
  if (!Number.isFinite(adv) || adv <= 0 || !Number.isFinite(orderNotional)) return min;
  const advShare = orderNotional / adv;
  if (!Number.isFinite(advShare)) return min;
  if (advShare <= 0.02) return 1; // tiny relative to tape — no slicing needed
  const needed = Math.ceil(advShare / participation);
  if (!Number.isFinite(needed)) return max;
  return Math.max(min, Math.min(max, needed));
}

// Build the send schedule. `windowMinutes` is total wall-clock horizon;
// buckets are placed at even time offsets, but quantity per bucket
// follows the strategy's weight curve.
//
// Total by construction: any non-finite or out-of-range input is clamped, the
// output length never exceeds MAX_SLICES, every qty is finite and positive,
// and offsets are non-decreasing and inside the window.
export function buildSliceSchedule(params: {
  strategy: SliceStrategy;
  totalQty: number;
  nSlices: number;
  windowMinutes: number;
  minLotSize?: number;
}): ScheduleBucket[] {
  const strategy: SliceStrategy =
    params.strategy === "twap" || params.strategy === "immediate" ? params.strategy : "vwap";
  const totalQty = clampFinite(params.totalQty, MIN_LOT, 1e12, MIN_LOT);
  const n = normalizeSliceCount(params.nSlices);
  const windowMinutes = clampFinite(params.windowMinutes, 0, MAX_WINDOW_MINUTES, 0);

  if (strategy === "immediate" || n === 1) {
    return [{ qty: totalQty, offset_min: 0 }];
  }

  const weights = strategy === "vwap" ? vwapWeights(n) : twapWeights(n);
  // A lot larger than the order itself would floor every bucket to zero, so
  // never let the lot exceed an even split of the order.
  const requested = clampFinite(params.minLotSize, MIN_LOT, totalQty, 1e-4);
  const lot = Math.min(requested, totalQty / n);
  const step = windowMinutes / n;

  const raw = weights.map((w, i) => ({
    qty: Math.max(lot, Math.floor((totalQty * w) / lot) * lot),
    offset_min: Math.min(MAX_WINDOW_MINUTES, Math.max(0, Math.round(step * i))),
  }));

  // Fix rounding drift by putting any residual into the largest bucket.
  const sum = raw.reduce((a, b) => a + b.qty, 0);
  const residual = totalQty - sum;
  if (Number.isFinite(residual) && Math.abs(residual) > lot / 2) {
    const idx = raw.reduce((best, b, i, arr) => (b.qty > (arr[best] as ScheduleBucket).qty ? i : best), 0);
    const target = raw[idx] as ScheduleBucket;
    raw[idx] = { ...target, qty: Math.max(lot, target.qty + residual) };
  }

  // Final sanity pass — no NaN escapes, offsets stay non-decreasing.
  let prevOffset = 0;
  return raw.map((b) => {
    const qty = Number.isFinite(b.qty) && b.qty > 0 ? b.qty : lot;
    const offset = Number.isFinite(b.offset_min) ? Math.max(prevOffset, b.offset_min) : prevOffset;
    prevOffset = offset;
    return { qty, offset_min: offset };
  });
}

/**
 * Validate a schedule read back from the database. Legacy or corrupted
 * `schedule_json` (nulls, NaN, strings, absurd offsets) must never drive the
 * next child order — callers fall back to their fixed cadence instead.
 */
export function sanitizeSchedule(value: unknown): ScheduleBucket[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SLICES) return null;
  const out: ScheduleBucket[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const qty = Number((entry as { qty?: unknown }).qty);
    const offset = Number((entry as { offset_min?: unknown }).offset_min);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    if (!Number.isFinite(offset) || offset < 0 || offset > MAX_WINDOW_MINUTES) return null;
    out.push({ qty, offset_min: offset });
  }
  return out;
}


// Spread-aware limit price. For a `buy` we post just below the ask;
// for a `sell` just above the bid. `aggressiveness` in [0,1]: 0 posts
// at mid, 1 crosses the whole spread. Default 0.35 captures most of
// the queue without giving up all the edge.
export function spreadAwareLimit(params: {
  midPrice: number;
  spreadBps: number;
  side: "buy" | "sell";
  aggressiveness?: number;
}): number {
  const { midPrice, spreadBps, side } = params;
  if (!Number.isFinite(midPrice) || midPrice <= 0) return midPrice;
  const aggr = Math.max(0, Math.min(1, params.aggressiveness ?? 0.35));
  const halfSpread = (Math.max(0, spreadBps) / 2) * 1e-4;
  const edge = midPrice * halfSpread * aggr;
  return side === "buy" ? midPrice + edge : midPrice - edge;
}
