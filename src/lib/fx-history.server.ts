// Daily FX close history from Frankfurter (ECB reference rates, keyless).
// Server-only. Used by the FX leg history chart and the playbook backtest.
//
// Frankfurter exposes a time-series endpoint:
//   /v1/2024-01-01..2024-03-01?base=GBP&symbols=USD
// returning { rates: { "2024-01-02": { USD: 1.27 }, ... } } on business days.

export type FxHistoryBar = { date: string; rate: number };

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const cache = new Map<string, { ts: number; bars: FxHistoryBar[] }>();
const TTL_MS = 30 * 60 * 1000;

/** Daily closes of `quote per 1 base` between two dates (inclusive). */
export async function fetchFxHistory(
  base: string,
  quote: string,
  fromDate: Date,
  toDate: Date = new Date(),
): Promise<FxHistoryBar[]> {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  if (b === q) return [];
  const key = `${b}${q}:${ymd(fromDate)}:${ymd(toDate)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.bars;

  const url = `https://api.frankfurter.dev/v1/${ymd(fromDate)}..${ymd(toDate)}?base=${b}&symbols=${q}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // best effort
    }
    throw new Error(`frankfurter history ${res.status}`);
  }
  const json = (await res.json()) as { rates?: Record<string, Record<string, number>> };
  const bars: FxHistoryBar[] = Object.entries(json?.rates ?? {})
    .map(([date, r]) => ({ date, rate: Number(r?.[q]) }))
    .filter((x) => Number.isFinite(x.rate) && x.rate > 0)
    .sort((x, y) => x.date.localeCompare(y.date));

  cache.set(key, { ts: Date.now(), bars });
  return bars;
}

export function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
