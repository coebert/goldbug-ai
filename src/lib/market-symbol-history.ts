// Pure computation behind the Market pulse drill-down page.
//
// Takes raw daily closes for one symbol out of `price_cache` and produces the
// window the chart draws plus the summary stats above it. Percentage moves are
// unit-agnostic (close ÷ close), so GBX-quoted LSE symbols need no scaling.

import { PULSE_COMPARISON, PULSE_INSTRUMENTS, PULSE_SECTORS, type PriceRow } from "./market-pulse";

/** Selectable time ranges on the drill-down page, in calendar days. */
export const HISTORY_RANGES = [30, 90, 180, 365, 1095] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];
export const DEFAULT_RANGE: HistoryRange = 90;

export function rangeLabel(days: number): string {
  if (days >= 365 && days % 365 === 0) return `${days / 365}y`;
  return `${days}d`;
}

export function isHistoryRange(v: unknown): v is HistoryRange {
  return typeof v === "number" && (HISTORY_RANGES as readonly number[]).includes(v);
}

export function coerceRange(v: unknown): HistoryRange {
  const n = typeof v === "string" ? Number(v) : v;
  return isHistoryRange(n) ? n : DEFAULT_RANGE;
}

export interface SymbolMeta {
  symbol: string;
  label: string;
  /** Extra context line, e.g. "US sector" or "Volatility". */
  kind: string;
}

const META: Map<string, SymbolMeta> = new Map();
for (const i of PULSE_INSTRUMENTS) {
  META.set(i.symbol, { symbol: i.symbol, label: i.label, kind: "Market" });
}
for (const s of PULSE_SECTORS) {
  if (!META.has(s.symbol)) META.set(s.symbol, { symbol: s.symbol, label: s.label, kind: "US sector" });
}
for (const c of PULSE_COMPARISON) {
  if (!META.has(c.symbol)) META.set(c.symbol, { symbol: c.symbol, label: c.label, kind: "Market" });
}

/** Symbols the drill-down page is allowed to chart. */
export const HISTORY_SYMBOLS: string[] = [...META.keys()];

export function symbolMeta(symbol: string): SymbolMeta | null {
  return META.get(symbol) ?? null;
}

export function isKnownSymbol(symbol: string): boolean {
  return META.has(symbol);
}

/** Simple-moving-average periods available on charts, in trading days. */
export const SMA_PERIODS = [20, 50, 100, 200] as const;
export type SmaPeriod = (typeof SMA_PERIODS)[number];

/** Chart series key for a period, e.g. 50 -> "sma50". */
export function smaKey(period: SmaPeriod): `sma${SmaPeriod}` {
  return `sma${period}` as `sma${SmaPeriod}`;
}

export function isSmaPeriod(value: number): value is SmaPeriod {
  return (SMA_PERIODS as readonly number[]).includes(value);
}

export interface HistoryPoint {
  date: string;
  close: number;
  /** Indexed to 100 at the start of the selected window. */
  indexed: number;
  sma20: number | null;
  sma50: number | null;
  sma100: number | null;
  sma200: number | null;
}

export interface SymbolHistory {
  symbol: string;
  label: string;
  kind: string;
  days: number;
  points: HistoryPoint[];
  last: number | null;
  asOf: string | null;
  changePct: number | null;
  changeAbs: number | null;
  high: number | null;
  low: number | null;
  /** Annualised standard deviation of daily returns, in %. */
  volatilityPct: number | null;
  /** Worst peak-to-trough fall inside the window, in %. */
  maxDrawdownPct: number | null;
  sma50: number | null;
  sma200: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  /** Latest value of every supported average, keyed by period. */
  smaLatest: Record<SmaPeriod, number | null>;
  /** Whether the last close sits above each average; null when unavailable. */
  aboveSma: Record<SmaPeriod, boolean | null>;
}

function cleanSorted(rows: PriceRow[]): PriceRow[] {
  return rows
    .filter((r) => r && Number.isFinite(r.close) && r.close > 0)
    .slice()
    .sort((a, b) => a.price_date.localeCompare(b.price_date));
}

function trailingAverage(values: number[], endIndex: number, window: number): number | null {
  if (endIndex + 1 < window) return null;
  let sum = 0;
  for (let i = endIndex - window + 1; i <= endIndex; i++) sum += values[i];
  return sum / window;
}

/**
 * Build the chart window. `rows` should include extra history before the
 * window so the 50/200-day averages are populated from the first point.
 */
export function buildSymbolHistory(
  symbol: string,
  rows: PriceRow[],
  days: number,
): SymbolHistory {
  const meta = symbolMeta(symbol);
  const all = cleanSorted(rows);
  const closes = all.map((r) => r.close);

  // Calendar-day cut so "90d" means 90 days of tape, not 90 sessions.
  const cutoff = all.length
    ? new Date(new Date(`${all[all.length - 1].price_date}T00:00:00Z`).getTime() - days * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : null;
  const startIdx = cutoff ? all.findIndex((r) => r.price_date >= cutoff) : -1;
  const from = startIdx >= 0 ? startIdx : 0;

  const points: HistoryPoint[] = [];
  const base = all[from]?.close ?? null;
  for (let i = from; i < all.length; i++) {
    points.push({
      date: all[i].price_date,
      close: all[i].close,
      indexed: base && base > 0 ? Number(((all[i].close / base) * 100).toFixed(3)) : 100,
      sma20: trailingAverage(closes, i, 20),
      sma50: trailingAverage(closes, i, 50),
      sma100: trailingAverage(closes, i, 100),
      sma200: trailingAverage(closes, i, 200),
    });
  }

  const last = points.length ? points[points.length - 1].close : null;
  const first = points.length ? points[0].close : null;

  let high: number | null = null;
  let low: number | null = null;
  let peak = 0;
  let maxDd: number | null = null;
  const rets: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const c = points[i].close;
    high = high == null ? c : Math.max(high, c);
    low = low == null ? c : Math.min(low, c);
    peak = Math.max(peak, c);
    if (peak > 0) {
      const dd = ((c - peak) / peak) * 100;
      maxDd = maxDd == null ? dd : Math.min(maxDd, dd);
    }
    if (i > 0) {
      const prev = points[i - 1].close;
      if (prev > 0) rets.push(c / prev - 1);
    }
  }

  let volatilityPct: number | null = null;
  if (rets.length >= 5) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    volatilityPct = Math.sqrt(variance) * Math.sqrt(252) * 100;
  }

  const lastPoint = points.length ? points[points.length - 1] : null;

  return {
    symbol,
    label: meta?.label ?? symbol,
    kind: meta?.kind ?? "Market",
    days,
    points,
    last,
    asOf: lastPoint?.date ?? null,
    changePct: first && first > 0 && last != null ? ((last - first) / first) * 100 : null,
    changeAbs: first != null && last != null ? last - first : null,
    high,
    low,
    volatilityPct,
    maxDrawdownPct: maxDd,
    sma50: lastPoint?.sma50 ?? null,
    sma200: lastPoint?.sma200 ?? null,
    aboveSma50: lastPoint?.sma50 != null && last != null ? last > lastPoint.sma50 : null,
    aboveSma200: lastPoint?.sma200 != null && last != null ? last > lastPoint.sma200 : null,
    smaLatest: Object.fromEntries(
      SMA_PERIODS.map((p) => [p, lastPoint?.[smaKey(p)] ?? null]),
    ) as Record<SmaPeriod, number | null>,
    aboveSma: Object.fromEntries(
      SMA_PERIODS.map((p) => {
        const avg = lastPoint?.[smaKey(p)] ?? null;
        return [p, avg != null && last != null ? last > avg : null];
      }),
    ) as Record<SmaPeriod, boolean | null>,
  };
}
