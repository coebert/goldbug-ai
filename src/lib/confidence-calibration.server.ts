// Turns persisted decisions + `price_cache` closes into calibration samples:
// for every past order with a recorded conviction, did the price move the
// trade's way over the next N trading sessions?

import { buildAuditEntries } from "./audit-log";
import { priceSymbolVariants } from "./price-symbol";
import type { CalibrationSample } from "./confidence-calibration";

export type PriceRow = { symbol: string; price_date: string; close: number };

type DecisionRow = { id: string; run_date: string; portfolio_value: number | string | null; raw: unknown };

/** Sessions per symbol, ascending by date, keyed uppercase. */
export function indexPrices(rows: PriceRow[]): Map<string, Array<{ date: string; close: number }>> {
  const by = new Map<string, Array<{ date: string; close: number }>>();
  for (const r of rows) {
    const key = String(r.symbol ?? "").toUpperCase();
    const close = Number(r.close);
    if (!key || !Number.isFinite(close) || close <= 0) continue;
    const arr = by.get(key) ?? [];
    arr.push({ date: String(r.price_date).slice(0, 10), close });
    by.set(key, arr);
  }
  for (const arr of by.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return by;
}

/**
 * Forward return in the direction of the trade over `horizonDays` sessions.
 * Returns null when the symbol or the forward session is missing.
 */
export function forwardReturn(
  series: Array<{ date: string; close: number }> | undefined,
  runDate: string,
  side: "buy" | "sell",
  horizonDays: number,
): number | null {
  if (!series || series.length < 2) return null;
  const startIdx = series.findIndex((p) => p.date >= runDate);
  if (startIdx < 0) return null;
  const endIdx = startIdx + horizonDays;
  if (endIdx >= series.length) return null;
  const a = series[startIdx].close;
  const b = series[endIdx].close;
  if (!(a > 0) || !(b > 0)) return null;
  const raw = (b - a) / a;
  return side === "buy" ? raw : -raw;
}

export function buildCalibrationSamples(
  decisions: DecisionRow[],
  prices: PriceRow[],
  horizonDays: number,
): CalibrationSample[] {
  const bySymbol = indexPrices(prices);
  const entries = buildAuditEntries(decisions as never);
  const out: CalibrationSample[] = [];
  for (const e of entries) {
    if (e.conviction == null || !Number.isFinite(e.conviction)) continue;
    const series = priceSymbolVariants(e.symbol)
      .map((v) => bySymbol.get(v))
      .find((s) => s && s.length > 1);
    const ret = forwardReturn(series, e.runDate, e.side, horizonDays);
    if (ret == null) continue;
    out.push({
      conviction: Math.max(0, Math.min(1, e.conviction)),
      hit: ret > 0,
      forwardReturn: ret,
    });
  }
  return out;
}

/** Distinct price_cache keys we need for a set of decision entries. */
export function calibrationSymbolKeys(decisions: DecisionRow[]): string[] {
  const entries = buildAuditEntries(decisions as never);
  const keys = new Set<string>();
  for (const e of entries) for (const v of priceSymbolVariants(e.symbol)) keys.add(v);
  return [...keys];
}
