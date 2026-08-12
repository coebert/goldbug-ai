// Pure builder for the portfolio "equity composition over time" chart.
//
// The database stores only aggregate equity snapshots (cash / holdings_value /
// total_value) — there is no per-symbol history table. This module
// reconstructs the per-asset split by replaying the trade ledger to get the
// position size held on each snapshot date, valuing it with the latest daily
// close on or before that date, and then SCALING those raw values so they sum
// exactly to the authoritative `holdings_value` from the snapshot.
//
// Scaling matters: reconstructed marks drift from the broker's own valuation
// (stale closes, FX, corporate actions). Anchoring to the snapshot keeps the
// stacked areas adding up to the real total equity line.

export type CompositionTrade = {
  trade_date: string;
  symbol: string;
  side: string;
  quantity: number | string | null;
};

export type CompositionSnapshot = {
  snapshot_date: string;
  cash: number | string | null;
  holdings_value: number | string | null;
  total_value: number | string | null;
};

export type CompositionPrice = { date: string; close: number };

export type CompositionRow = Record<string, number | string | null> & { date: string };

/** A stretch of missing trading days between two real snapshots. */
export type CompositionGap = {
  /** Last real snapshot before the gap. */
  from: string;
  /** First real snapshot after the gap. */
  to: string;
  /** Number of missing weekdays between them. */
  missingDays: number;
  /** True when the gap was short enough to fill by linear interpolation. */
  interpolated: boolean;
};

export type EquityComposition = {
  /** Stacked series keys, largest average weight first. `cash` is separate. */
  symbols: string[];
  rows: CompositionRow[];
  currency: string;
  /** Missing-snapshot stretches, whether filled or left as visible breaks. */
  gaps: CompositionGap[];
};

/** Marker fields present on rows the builder synthesised (not real snapshots). */
export const ROW_INTERPOLATED = "_interpolated";
export const ROW_GAP = "_gap";

export const isRealRow = (row: CompositionRow) =>
  !row[ROW_INTERPOLATED] && !row[ROW_GAP];

/** Gaps up to this many missing weekdays are filled by interpolation. */
export const DEFAULT_MAX_INTERPOLATE_DAYS = 3;

const num = (v: unknown, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function closeOnOrBefore(series: CompositionPrice[], date: string): number | undefined {
  if (!series.length || date < series[0].date) return undefined;
  let out: number | undefined;
  for (const p of series) {
    if (p.date <= date) out = p.close;
    else break;
  }
  return out;
}

export function buildEquityComposition({
  snapshots,
  trades,
  prices,
  currency = "GBP",
  maxSymbols = 8,
  maxInterpolateDays = DEFAULT_MAX_INTERPOLATE_DAYS,
}: {
  snapshots: CompositionSnapshot[];
  trades: CompositionTrade[];
  /** Base-currency daily closes keyed by the holding symbol, oldest first. */
  prices: Record<string, CompositionPrice[]>;
  currency?: string;
  maxSymbols?: number;
  /** Longest run of missing weekdays that may be interpolated. */
  maxInterpolateDays?: number;
}): EquityComposition {
  const snaps = [...snapshots].sort((a, b) =>
    a.snapshot_date.localeCompare(b.snapshot_date),
  );
  if (snaps.length === 0) return { symbols: [], rows: [], currency, gaps: [] };

  const sortedTrades = [...trades].sort((a, b) => a.trade_date.localeCompare(b.trade_date));

  // Pass 1: raw per-symbol value on every snapshot date.
  const qty = new Map<string, number>();
  let cursor = 0;
  const raw: Array<{ date: string; values: Map<string, number> }> = [];

  for (const snap of snaps) {
    const date = snap.snapshot_date;
    while (cursor < sortedTrades.length && sortedTrades[cursor].trade_date <= date) {
      const t = sortedTrades[cursor++];
      const q = num(t.quantity);
      const signed = String(t.side).toLowerCase() === "sell" ? -q : q;
      qty.set(t.symbol, (qty.get(t.symbol) ?? 0) + signed);
    }
    const values = new Map<string, number>();
    for (const [symbol, held] of qty) {
      if (held <= 1e-9) continue;
      const close = closeOnOrBefore(prices[symbol] ?? [], date);
      if (close == null || !Number.isFinite(close)) continue;
      const v = held * close;
      if (v > 0) values.set(symbol, v);
    }
    raw.push({ date, values });
  }

  // Rank symbols by average share so the legend/stack order is stable.
  const totals = new Map<string, number>();
  for (const r of raw) for (const [s, v] of r.values) totals.set(s, (totals.get(s) ?? 0) + v);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const kept = ranked.slice(0, maxSymbols);
  const keptSet = new Set(kept);
  const hasOther = ranked.length > kept.length;

  const rows: CompositionRow[] = raw.map((r, i) => {
    const snap = snaps[i];
    const cash = Math.max(0, num(snap.cash));
    const total = num(snap.total_value, cash);
    const holdingsValue = Math.max(0, num(snap.holdings_value, Math.max(0, total - cash)));
    const rawSum = [...r.values.values()].reduce((s, v) => s + v, 0);
    const scale = rawSum > 0 ? holdingsValue / rawSum : 0;

    const row: CompositionRow = { date: r.date, cash, total: cash + holdingsValue };
    let other = 0;
    for (const [symbol, v] of r.values) {
      const scaled = v * scale;
      if (keptSet.has(symbol)) row[symbol] = scaled;
      else other += scaled;
    }
    for (const s of kept) if (row[s] == null) row[s] = 0;
    if (hasOther) row.other = other;
    // If we could not price anything but the snapshot says there are holdings,
    // surface the gap so the stack still reaches the total equity line.
    if (rawSum === 0 && holdingsValue > 0) row.unpriced = holdingsValue;
    else if (hasOther || kept.length) row.unpriced = 0;
    return row;
  });

  const symbols = [...kept];
  if (hasOther) symbols.push("other");
  if (rows.some((r) => num(r.unpriced) > 0)) symbols.push("unpriced");

  const seriesKeys = ["cash", ...symbols, "total"];
  const { rows: filled, gaps } = fillCompositionGaps(rows, seriesKeys, maxInterpolateDays);

  return { symbols, rows: filled, currency, gaps };
}

// ---------------------------------------------------------------------------
// Missing-snapshot handling.
//
// Snapshots can be missing for a day (worker outage, broker downtime). Short
// gaps are filled by linear interpolation between the surrounding snapshots so
// the stack stays continuous; long gaps are NOT invented — they are marked with
// null-valued rows so the chart visibly breaks and the UI can say why.

const DAY_MS = 86_400_000;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/** Weekday ISO dates strictly between two dates (markets are shut at weekends). */
function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = toDate(to).getTime();
  for (let t = toDate(from).getTime() + DAY_MS; t < end; t += DAY_MS) {
    const d = new Date(t);
    if (!isWeekend(d)) out.push(toIso(d));
  }
  return out;
}

export function fillCompositionGaps(
  rows: CompositionRow[],
  keys: string[],
  maxInterpolateDays = DEFAULT_MAX_INTERPOLATE_DAYS,
): { rows: CompositionRow[]; gaps: CompositionGap[] } {
  if (rows.length < 2) return { rows, gaps: [] };

  const out: CompositionRow[] = [rows[0]];
  const gaps: CompositionGap[] = [];

  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const next = rows[i];
    const missing = weekdaysBetween(prev.date, next.date);

    if (missing.length > 0) {
      const interpolated = missing.length <= maxInterpolateDays;
      gaps.push({
        from: prev.date,
        to: next.date,
        missingDays: missing.length,
        interpolated,
      });

      if (interpolated) {
        const span = missing.length + 1;
        missing.forEach((date, idx) => {
          const w = (idx + 1) / span;
          const row: CompositionRow = { date, [ROW_INTERPOLATED]: 1 };
          for (const k of keys) {
            const a = num(prev[k]);
            const b = num(next[k]);
            row[k] = a + (b - a) * w;
          }
          out.push(row);
        });
      } else {
        // Leave the series genuinely empty across the gap so it renders as a
        // break rather than a straight line through data we never had.
        for (const date of missing) {
          const row: CompositionRow = { date, [ROW_GAP]: 1 };
          for (const k of keys) row[k] = null;
          out.push(row);
        }
      }
    }

    out.push(next);
  }

  return { rows: out, gaps };
}

// ---------------------------------------------------------------------------
// Validation: every stacked band on a row must add up to that row's stored
// total equity. A mismatch means the composition is misleading (bands would
// not reach, or would overshoot, the recorded equity line), so the UI shows an
// error banner rather than silently drawing a wrong chart.

export type CompositionMismatch = {
  date: string;
  stacked: number;
  total: number;
  diff: number;
};

/** Absolute tolerance (currency units) for float accumulation noise. */
const SUM_TOLERANCE = 0.01;

export function validateComposition(
  rows: CompositionRow[],
  keys: string[],
  tolerance = SUM_TOLERANCE,
): CompositionMismatch[] {
  const out: CompositionMismatch[] = [];
  for (const row of rows) {
    // Gap rows are intentionally empty; interpolated rows are derived from the
    // same arithmetic and are checked like any other row.
    if (row[ROW_GAP]) continue;
    const total = num(row.total);
    const stacked = keys.reduce((s, k) => s + num(row[k]), 0);
    const diff = stacked - total;
    // Scale tolerance a touch with size so large portfolios aren't flagged for
    // sub-basis-point rounding.
    const tol = Math.max(tolerance, Math.abs(total) * 1e-6);
    if (Math.abs(diff) > tol) out.push({ date: row.date, stacked, total, diff });
  }
  return out;
}
