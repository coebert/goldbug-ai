// Single source of truth for the portfolio card's equity headline
// and its % change. Both numbers MUST derive from the same last
// sparkline point; if the caller ever passes shapes that would make
// them disagree, this helper fails fast (throws in dev, logs a
// structured error in prod) so the bug surfaces at the boundary
// rather than as a silently mismatched card.
//
// Invariants enforced at runtime:
//   1. `totalEquity` is exactly `sparkSeries[last].value` when the
//      series is non-empty; otherwise it falls back to `fallbackCash`.
//   2. The % change is computed from the SAME `sparkSeries` array
//      that feeds `totalEquity` — never from a re-fetched, cached,
//      or independently-valued series.
//   3. When `hasSeries` is true, the derived `sourceLastValue`
//      returned alongside the headline equals `totalEquity` — this
//      is a self-check that the invariant held through the call.
//
// The helper returns everything the card needs so PortfolioRow has
// no opportunity to re-derive either value from a different source.

import { computeCardRangePct, type CardSparkPoint } from "./card-range-pct";
import type { DepositPoint } from "./deposit-adjusted-series";

export type CardEquityDerivation = {
  totalEquity: number;
  rangePct: number | null;
  hasSeries: boolean;
  /** Last point of the same series used for the %. Equal to
   *  totalEquity when hasSeries; undefined otherwise. */
  sourceLastValue: number | undefined;
  sourceLastDate: string | undefined;
};

class EquitySourceMismatchError extends Error {
  constructor(message: string, public details: Record<string, unknown>) {
    super(message);
    this.name = "EquitySourceMismatchError";
  }
}

function isDev(): boolean {
  // Vitest sets NODE_ENV=test; treat test as dev so tests can assert
  // the throw path. Production runtime (Cloudflare Worker) has
  // NODE_ENV=production and only logs.
  const env =
    (typeof process !== "undefined" && process.env?.NODE_ENV) || "production";
  return env !== "production";
}

function fail(message: string, details: Record<string, unknown>): never | void {
  if (isDev()) {
    throw new EquitySourceMismatchError(message, details);
  }
  // Prod: structured log, never crash the dashboard.
  // eslint-disable-next-line no-console
  console.error(`[card-equity] ${message}`, details);
}

export function deriveCardEquity(
  sparkSeries: CardSparkPoint[],
  slicedForRange: CardSparkPoint[],
  deposits: DepositPoint[],
  includeDeposits: boolean,
  fallbackCash: number,
): CardEquityDerivation {
  const hasSeries = sparkSeries.length > 0;

  // Invariant #2: the sliced view fed into the % helper MUST be a
  // (possibly trimmed) suffix of the same sparkSeries array — never
  // a foreign series. The cheapest check is identity on the last
  // point: if the last dates and values match, the caller sliced the
  // same array.
  if (hasSeries && slicedForRange.length > 0) {
    const seriesLast = sparkSeries[sparkSeries.length - 1];
    const slicedLast = slicedForRange[slicedForRange.length - 1];
    if (
      slicedLast.date !== seriesLast.date ||
      slicedLast.value !== seriesLast.value
    ) {
      fail("sliced range series does not share the last point of sparkSeries", {
        seriesLast,
        slicedLast,
      });
    }
  }

  const totalEquity = hasSeries
    ? sparkSeries[sparkSeries.length - 1].value
    : Number(fallbackCash);

  const rangePct = computeCardRangePct(slicedForRange, deposits, includeDeposits);

  const sourceLastValue = hasSeries
    ? sparkSeries[sparkSeries.length - 1].value
    : undefined;
  const sourceLastDate = hasSeries
    ? sparkSeries[sparkSeries.length - 1].date
    : undefined;

  // Invariant #3: self-check. If a future edit introduces any
  // transform between reading sparkSeries[last] and assigning it to
  // totalEquity, this catches it immediately.
  if (hasSeries && sourceLastValue !== totalEquity) {
    fail("totalEquity diverged from sparkSeries[last].value", {
      totalEquity,
      sourceLastValue,
      sourceLastDate,
    });
  }

  // Invariant #1: fallback is only permitted when the series is empty.
  if (!hasSeries && !Number.isFinite(Number(fallbackCash))) {
    fail("fallbackCash must be a finite number when sparkSeries is empty", {
      fallbackCash,
    });
  }

  return { totalEquity, rangePct, hasSeries, sourceLastValue, sourceLastDate };
}

export { EquitySourceMismatchError };
