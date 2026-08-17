// Broker order-price tick-size rounding.
//
// Saxo rejects any limit/stop whose price is not an exact multiple of the
// instrument's tick size: "The order price is not in tick size increments."
// That is what blocked the MKS sell after the GBX/GBP fix — 404.75p is not a
// valid increment for an LSE stock whose tick in that price band is 0.20p.
//
// This module is pure so it can be unit-tested without a broker session.

export type SaxoTickSizeScheme = {
  DefaultTickSize?: number | null;
  Elements?: Array<{ HighPrice?: number | null; TickSize?: number | null }> | null;
};

/**
 * FCA/MiFID II liquidity-band tick ladder used as a fallback for LSE
 * pence-quoted stocks when the broker doesn't return a scheme. Conservative:
 * picks the coarsest plausible tick for the band so the price is always a
 * valid increment (a multiple of a coarse tick is also a multiple of a
 * finer one only when the finer tick divides it — 0.20/0.50 ticks below do
 * divide by 0.10/0.05, so this stays safe).
 */
function fallbackLseTick(pencePrice: number): number {
  if (pencePrice < 50) return 0.05;
  if (pencePrice < 100) return 0.1;
  if (pencePrice < 500) return 0.2;
  if (pencePrice < 1000) return 0.5;
  if (pencePrice < 5000) return 1;
  return 2;
}

/** Resolve the tick size that applies at `price` for a Saxo tick scheme. */
export function tickSizeForPrice(
  price: number,
  scheme?: SaxoTickSizeScheme | null,
  opts?: { penceQuoted?: boolean },
): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const elements = (scheme?.Elements ?? [])
    .map((e) => ({
      high: Number(e?.HighPrice),
      tick: Number(e?.TickSize),
    }))
    .filter((e) => Number.isFinite(e.high) && Number.isFinite(e.tick) && e.tick > 0)
    .sort((a, b) => a.high - b.high);
  for (const el of elements) {
    if (price <= el.high) return el.tick;
  }
  const def = Number(scheme?.DefaultTickSize);
  if (Number.isFinite(def) && def > 0) return def;
  if (opts?.penceQuoted) return fallbackLseTick(price);
  return null;
}

/**
 * Snap a broker-bound price onto the instrument's tick grid.
 *
 * Direction matters for marketable limits: a sell rounds DOWN and a buy
 * rounds UP, so snapping can only make the order *more* likely to fill, never
 * less. Stops use the same convention (sell stop below, buy stop above).
 */
export function roundPriceToTick(
  price: number,
  tick: number | null | undefined,
  side: "buy" | "sell",
): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const t = Number(tick);
  if (!Number.isFinite(t) || t <= 0) return Math.round(price * 100) / 100;
  // Work in integer tick units to avoid binary-float drift (404.75 / 0.2).
  const units = price / t;
  const snapped = side === "sell" ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9);
  const out = snapped * t;
  // Ticks are never finer than 1e-6 in practice; trim float noise.
  return Math.round(out * 1e6) / 1e6;
}
