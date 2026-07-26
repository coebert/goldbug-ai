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

// Classic U-shape intraday volume weights, roughly matching S&P 500
// tape studies (Almgren & Chriss, 2000). We build the weights on the fly
// from a two-hump curve so this scales to any bucket count.
export function vwapWeights(nSlices: number): number[] {
  const n = Math.max(2, Math.floor(nSlices));
  const raw = Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n; // bucket midpoint in [0,1]
    // Two Gaussians centred near open (t=0.1) and close (t=0.95),
    // plus a small constant floor so midday slices are never zero.
    const openHump = Math.exp(-((t - 0.10) ** 2) / (2 * 0.08 ** 2));
    const closeHump = 1.35 * Math.exp(-((t - 0.95) ** 2) / (2 * 0.08 ** 2));
    return 0.35 + openHump + closeHump;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / total);
}

export function twapWeights(nSlices: number): number[] {
  const n = Math.max(2, Math.floor(nSlices));
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
  const min = opts.minSlices ?? 2;
  const max = opts.maxSlices ?? 8;
  const participation = opts.targetParticipation ?? 0.15;
  if (!advNotional || advNotional <= 0 || !Number.isFinite(orderNotional)) return min;
  const advShare = orderNotional / advNotional;
  if (advShare <= 0.02) return 1; // tiny relative to tape — no slicing needed
  const needed = Math.ceil(advShare / participation);
  return Math.max(min, Math.min(max, needed));
}

// Build the send schedule. `windowMinutes` is total wall-clock horizon;
// buckets are placed at even time offsets, but quantity per bucket
// follows the strategy's weight curve.
export function buildSliceSchedule(params: {
  strategy: SliceStrategy;
  totalQty: number;
  nSlices: number;
  windowMinutes: number;
  minLotSize?: number;
}): ScheduleBucket[] {
  const { strategy, totalQty, nSlices, windowMinutes } = params;
  const n = Math.max(1, Math.floor(nSlices));
  if (strategy === "immediate" || n === 1) {
    return [{ qty: totalQty, offset_min: 0 }];
  }
  const weights = strategy === "vwap" ? vwapWeights(n) : twapWeights(n);
  const lot = params.minLotSize && params.minLotSize > 0 ? params.minLotSize : 1e-4;
  // Even time spacing across the window; last bucket sits at the end.
  const step = windowMinutes / n;
  const raw = weights.map((w, i) => ({
    qty: Math.max(lot, Math.floor((totalQty * w) / lot) * lot),
    offset_min: Math.round(step * i),
  }));
  // Fix rounding drift by putting any residual into the largest bucket.
  const sum = raw.reduce((a, b) => a + b.qty, 0);
  const residual = totalQty - sum;
  if (Math.abs(residual) > lot / 2) {
    const idx = raw.reduce((best, b, i, arr) => (b.qty > arr[best].qty ? i : best), 0);
    raw[idx] = { ...raw[idx], qty: Math.max(lot, raw[idx].qty + residual) };
  }
  return raw;
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
