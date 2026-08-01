// Pure builder for holding sparkline series. Extracted from
// `getHoldingsHistory` so window/baseline invariants can be unit tested
// without a database round-trip. The server function is a thin wrapper that
// resolves rows from Supabase and delegates to this function.

import { holdingAvgCostBase, normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";

export type HoldingInput = {
  symbol: string;
  quantity: number | string;
  avg_cost: number | string;
  opened_at?: string | null;
  asset_class?: string | null;
};

export type PricePoint = { date: string; close: number };
/** Hour-bucketed observation, `at` is an ISO timestamp. */
export type IntradayPoint = { at: string; close: number };

export type BuiltHoldingSeries = {
  symbol: string;
  opened_at: string | null;
  avg_cost: number;
  quantity: number;
  closes: number[];
  /** Hour-bucketed prices since purchase, same normalisation as `closes`. */
  hourly: number[];
  /** ISO timestamps aligned 1:1 with `hourly`. */
  hourlyAt: string[];
  currentPrice: number | null;
  pctChangeSincePurchase: number | null;
  valueChangeSincePurchase: number | null;
  points: number;
};

/**
 * Build one holding's series given its cached daily closes. `closes` in the
 * output are ALWAYS anchored at avg_cost as element 0 (when avg > 0) and
 * only include prices on/after `opened_at`, so the sparkline window and
 * baseline exactly match the "% since purchase" tile.
 *
 * `intraday` (optional) carries hour-bucketed observations recorded by the
 * broker sync. They go through identical filtering/normalisation, so the
 * hourly view is a higher-resolution version of the same line rather than a
 * differently-scaled one.
 */
export function buildHoldingSeries(
  h: HoldingInput,
  cachedCloses: PricePoint[],
  intraday: IntradayPoint[] = [],
): BuiltHoldingSeries {
  const assetClass = h.asset_class ?? null;
  // avg_cost is persisted in base currency already — do not re-normalise.
  const avg = holdingAvgCostBase(h.symbol, h.avg_cost);
  const openedAt = h.opened_at ?? null;
  const openedDate = openedAt ? openedAt.slice(0, 10) : null;

  const postPurchase = openedDate
    ? cachedCloses.filter((p) => p.date >= openedDate)
    : cachedCloses.slice();

  const postCloses = postPurchase.map((p) =>
    normalizeLseDisplayPriceToBase(h.symbol, Number(p.close), assetClass),
  );

  const closes = avg > 0 ? [avg, ...postCloses] : postCloses;

  const postIntraday = (openedDate
    ? intraday.filter((p) => String(p.at).slice(0, 10) >= openedDate)
    : intraday.slice()
  )
    .filter((p) => Number.isFinite(Number(p.close)) && Number(p.close) > 0)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const hourlyPrices = postIntraday.map((p) =>
    normalizeLseDisplayPriceToBase(h.symbol, Number(p.close), assetClass),
  );
  // Anchor the hourly line at the purchase price too, so both resolutions
  // start from the same zero and can't disagree about direction.
  const hourly = avg > 0 && hourlyPrices.length > 0 ? [avg, ...hourlyPrices] : hourlyPrices;
  const hourlyAt =
    avg > 0 && hourlyPrices.length > 0
      ? [openedAt ?? postIntraday[0].at, ...postIntraday.map((p) => p.at)]
      : postIntraday.map((p) => p.at);

  // Prefer the freshest observation available: an intraday point recorded this
  // hour is newer than yesterday's close.
  const latestDaily = postCloses.length > 0 ? postCloses[postCloses.length - 1] : null;
  const latestHourly = hourlyPrices.length > 0 ? hourlyPrices[hourlyPrices.length - 1] : null;
  const currentPrice =
    latestHourly ?? latestDaily ?? (closes.length > 0 ? closes[closes.length - 1] : null);
  const pct = currentPrice != null && avg > 0 ? (currentPrice - avg) / avg : null;
  const valueChange = currentPrice != null ? (currentPrice - avg) * Number(h.quantity) : null;

  return {
    symbol: h.symbol,
    opened_at: openedAt,
    avg_cost: avg,
    quantity: Number(h.quantity),
    closes,
    hourly,
    hourlyAt,
    currentPrice,
    pctChangeSincePurchase: pct,
    valueChangeSincePurchase: valueChange,
    points: closes.length,
  };
}

