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

export type CompositionRow = Record<string, number | string> & { date: string };

export type EquityComposition = {
  /** Stacked series keys, largest average weight first. `cash` is separate. */
  symbols: string[];
  rows: CompositionRow[];
  currency: string;
};

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
}: {
  snapshots: CompositionSnapshot[];
  trades: CompositionTrade[];
  /** Base-currency daily closes keyed by the holding symbol, oldest first. */
  prices: Record<string, CompositionPrice[]>;
  currency?: string;
  maxSymbols?: number;
}): EquityComposition {
  const snaps = [...snapshots].sort((a, b) =>
    a.snapshot_date.localeCompare(b.snapshot_date),
  );
  if (snaps.length === 0) return { symbols: [], rows: [], currency };

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

  return { symbols, rows, currency };
}
