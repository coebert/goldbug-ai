// Shaping backfilled hourly equity with real intraday prices.
//
// `deriveIntradayAnchors` can only place ONE point per historical day, because
// a daily snapshot is all it has. Where `price_intraday` recorded hourly
// prices for the symbols a portfolio held, we can do better: the *shape* of
// the day is known even though only its closing equity was snapshotted.
//
// Method: build a quantity-weighted price index across the hours observed on
// that day, then scale the day's known closing holdings value by
// `index(hour) / index(lastHour)`. Cash is held flat across the day (intraday
// cash moves are trades, which move holdings value by the same amount, so the
// total stays honest to within the day's trading). The final hour of each day
// reproduces the daily snapshot exactly, so the hourly line still agrees with
// the daily line at every close — it just gains the real intra-day path.
//
// Anything we cannot evidence is skipped rather than interpolated: days with
// fewer than two price observations, days with no known quantities, and
// snapshots without a cash/holdings split fall back to the single anchor.

import { anchorBucketFor, type IntradayRow, type SnapshotLite } from "./equity-intraday-backfill";

export type PriceObs = { symbol: string; bucket_hour: string; price: number | string };

export type TradeLite = {
  symbol: string;
  side: string;
  quantity: number | string;
  executed_at: string;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function hourIso(at: string): string | null {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * Quantity held at the END of each requested day, reconstructed by rewinding
 * today's holdings through the trade log.
 *
 * Walking backwards (rather than forwards from zero) is deliberate: the trade
 * table may not cover a portfolio's whole life (broker-imported positions have
 * no local trade rows), and the present-day quantities are authoritative.
 */
export function reconstructQuantitiesByDay(
  current: Map<string, number>,
  trades: TradeLite[],
  days: string[],
): Map<string, Map<string, number>> {
  const sortedDays = [...new Set(days.map((d) => d.slice(0, 10)))].sort().reverse();
  const sortedTrades = [...trades].sort((a, b) =>
    String(b.executed_at).localeCompare(String(a.executed_at)),
  );

  const out = new Map<string, Map<string, number>>();
  const running = new Map(current);
  let ti = 0;

  for (const day of sortedDays) {
    // Rewind every trade executed after this day ends.
    while (ti < sortedTrades.length && String(sortedTrades[ti].executed_at).slice(0, 10) > day) {
      const t = sortedTrades[ti++];
      const qty = num(t.quantity);
      if (!(qty > 0)) continue;
      const prev = running.get(t.symbol) ?? 0;
      // Undo the trade: a past BUY means we held less before it.
      const next = String(t.side).toLowerCase() === "buy" ? prev - qty : prev + qty;
      running.set(t.symbol, Math.max(0, next));
    }
    out.set(day, new Map([...running].filter(([, q]) => q > 0)));
  }
  return out;
}

/** Bucket -> symbol -> price, grouped by UTC day, with in-day carry-forward. */
function indexByDay(prices: PriceObs[]): Map<string, Array<{ bucket: string; px: Map<string, number> }>> {
  const perDay = new Map<string, Map<string, Map<string, number>>>();
  for (const p of prices) {
    const bucket = hourIso(String(p.bucket_hour));
    const price = num(p.price);
    if (!bucket || !(price > 0)) continue;
    const day = bucket.slice(0, 10);
    const buckets = perDay.get(day) ?? new Map<string, Map<string, number>>();
    const syms = buckets.get(bucket) ?? new Map<string, number>();
    syms.set(p.symbol, price);
    buckets.set(bucket, syms);
    perDay.set(day, buckets);
  }

  const out = new Map<string, Array<{ bucket: string; px: Map<string, number> }>>();
  for (const [day, buckets] of perDay) {
    const carried = new Map<string, number>();
    const rows = [...buckets.keys()]
      .sort()
      .map((bucket) => {
        for (const [s, v] of buckets.get(bucket)!) carried.set(s, v);
        return { bucket, px: new Map(carried) };
      });
    out.set(day, rows);
  }
  return out;
}

/**
 * Hourly equity rows for historical days, shaped by recorded intraday prices.
 * Days that cannot be evidenced return nothing and are left to the one-point
 * anchor backfill.
 */
export function deriveIntradayFromPrices(
  portfolioId: string,
  snapshots: SnapshotLite[],
  prices: PriceObs[],
  quantitiesByDay: Map<string, Map<string, number>>,
  existingBuckets: Iterable<string> = [],
  now: Date = new Date(),
): IntradayRow[] {
  const taken = new Set<string>();
  for (const b of existingBuckets) {
    const h = hourIso(String(b));
    if (h) taken.add(h);
  }

  const byDay = indexByDay(prices);
  const rows: IntradayRow[] = [];

  for (const s of snapshots) {
    const day = String(s.snapshot_date ?? "").slice(0, 10);
    const total = Number(s.total_value);
    if (!Number.isFinite(total)) continue;
    // Without a cash/holdings split we cannot say which part moves with price.
    if (s.cash == null || s.holdings_value == null) continue;

    const anchor = anchorBucketFor(day, now);
    if (!anchor) continue;
    const qty = quantitiesByDay.get(day);
    if (!qty || qty.size === 0) continue;

    const observed = (byDay.get(day) ?? []).filter((r) => r.bucket <= anchor);
    if (observed.length < 2) continue;

    const valueAt = (px: Map<string, number>): number => {
      let v = 0;
      let hits = 0;
      for (const [sym, q] of qty) {
        const p = px.get(sym);
        if (p == null || !(p > 0)) continue;
        v += q * p;
        hits += 1;
      }
      return hits > 0 ? v : NaN;
    };

    const closeIndex = valueAt(observed[observed.length - 1].px);
    if (!Number.isFinite(closeIndex) || closeIndex <= 0) continue;

    const cash = num(s.cash);
    const closeHoldings = num(s.holdings_value);

    for (const { bucket, px } of observed) {
      if (taken.has(bucket)) continue;
      const idx = valueAt(px);
      if (!Number.isFinite(idx) || idx <= 0) continue;
      const holdings = closeHoldings * (idx / closeIndex);
      taken.add(bucket);
      rows.push({
        portfolio_id: portfolioId,
        bucket_hour: bucket,
        cash,
        holdings_value: holdings,
        total_value: cash + holdings,
      });
    }
  }

  return rows.sort((a, b) => a.bucket_hour.localeCompare(b.bucket_hour));
}
