// Trade markers for time-series charts.
//
// Executed buys and sells are bucketed onto the x-values a chart actually
// plots (a daily close series, an hourly intraday series, or a drawdown
// curve), so a marker always sits exactly on a rendered point instead of
// floating between two of them.
//
// Pure and client-safe — no recharts, no DOM. The rendering shapes live in
// `src/components/charts/trade-markers.tsx`.

import {
  computeCommission,
  type CommissionBreakdown,
  type CommissionInput,
  type CommissionModel,
} from "./commission-model";

export type MarkerTrade = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number | string;
  price: number | string;
  /** `YYYY-MM-DD`. */
  trade_date: string;
  /** Full timestamp when known — preferred for hourly series. */
  executed_at?: string | null;
  /** Trade currency, used to route the commission schedule. */
  instrument_ccy?: string | null;
  asset_class?: string | null;
};

export type TradeMarkerCell = {
  buys: number;
  sells: number;
  /** Notional bought / sold at this point, in the series currency. */
  buyValue: number;
  sellValue: number;
  trades: MarkerTrade[];
};

const MS = (v: string): number => {
  const iso = v.length <= 10 ? `${v}T00:00:00Z` : v;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NaN;
};

/** Timestamp a trade should be plotted at. */
export function tradeTimestamp(t: MarkerTrade): number {
  const at = t.executed_at ? MS(String(t.executed_at)) : Number.NaN;
  return Number.isFinite(at) ? at : MS(String(t.trade_date));
}

/**
 * Snap each trade to the last chart x-value at or before it (trades before
 * the series starts snap forward to the first point, so an opening trade is
 * still visible). Returns one cell per x-value that has trades.
 */
export function bucketTradeMarkers(
  xValues: readonly string[],
  trades: readonly MarkerTrade[],
): Map<string, TradeMarkerCell> {
  const out = new Map<string, TradeMarkerCell>();
  if (xValues.length === 0) return out;
  const stamps = xValues.map((x) => MS(String(x)));
  const first = stamps[0];

  for (const t of trades) {
    const ts = tradeTimestamp(t);
    if (!Number.isFinite(ts)) continue;
    let idx = -1;
    if (ts < first) {
      idx = 0;
    } else {
      // Linear scan back-to-front: series are short and already sorted.
      for (let i = stamps.length - 1; i >= 0; i--) {
        if (Number.isFinite(stamps[i]) && stamps[i] <= ts) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) continue;
    const key = String(xValues[idx]);
    const cell =
      out.get(key) ?? { buys: 0, sells: 0, buyValue: 0, sellValue: 0, trades: [] };
    const value = Math.abs(Number(t.quantity) || 0) * Math.abs(Number(t.price) || 0);
    if (t.side === "sell") {
      cell.sells += 1;
      cell.sellValue += value;
    } else {
      cell.buys += 1;
      cell.buyValue += value;
    }
    cell.trades.push(t);
    out.set(key, cell);
  }
  return out;
}

export type MarkedRow<R> = R & {
  /** y-value for a buy marker at this point, or null when there were none. */
  buyMark: number | null;
  sellMark: number | null;
  marker: TradeMarkerCell | null;
};

/**
 * Attach `buyMark` / `sellMark` / `marker` to chart rows. Markers reuse the
 * plotted series value, so they sit precisely on the curve.
 */
export function attachTradeMarkers<R extends Record<string, unknown>>(
  rows: readonly R[],
  xField: keyof R & string,
  valueField: keyof R & string,
  trades: readonly MarkerTrade[],
): Array<MarkedRow<R>> {
  const cells = bucketTradeMarkers(
    rows.map((r) => String(r[xField])),
    trades,
  );
  return rows.map((r) => {
    const cell = cells.get(String(r[xField])) ?? null;
    const v = Number(r[valueField]);
    const y = Number.isFinite(v) ? v : null;
    return {
      ...r,
      buyMark: cell && cell.buys > 0 ? y : null,
      sellMark: cell && cell.sells > 0 ? y : null,
      marker: cell,
    };
  });
}

/** Commission the tiered model charges for a marker trade. */
export function tradeCommission(
  t: MarkerTrade,
  model?: CommissionModel,
): CommissionBreakdown {
  const quantity = Math.abs(Number(t.quantity) || 0);
  const price = Math.abs(Number(t.price) || 0);
  return computeCommission({
    notional: quantity * price,
    quantity,
    symbol: t.symbol,
    currency: t.instrument_ccy ?? null,
    assetClass: (t.asset_class ?? null) as CommissionInput["assetClass"],
    model,
  });
}

/**
 * One-line fee breakdown: effective bps, the per-ticket floor/cap that bound
 * it, the per-share component when the venue charges one, and the total fee.
 */
export function describeCommission(
  b: CommissionBreakdown,
  money: (v: number) => string,
): string {
  const parts: string[] = [];
  parts.push(Number.isFinite(b.bps) ? `${b.bps.toFixed(1)} bps` : "— bps");
  const floor = b.tier.min ?? 0;
  if (floor > 0) parts.push(`floor ${money(floor)}${b.minFloorApplied ? " ✓" : ""}`);
  const cap = b.tier.cap ?? 0;
  if (cap > 0) parts.push(`cap ${money(cap)}${b.capApplied ? " ✓" : ""}`);
  const perUnitRate = (b.tier.perUnit ?? 0) * b.volumeMultiplier;
  if (perUnitRate > 0) {
    parts.push(`${money(perUnitRate)}/sh → ${money(b.perUnit)}`);
  }
  parts.push(`fee ${money(b.commission)}`);
  return `   ${parts.join(" · ")}`;
}

export type MarkerCellOptions = {
  /** Append a commission breakdown line under each trade plus a total. */
  commission?: boolean;
  model?: CommissionModel;
};

/** Compact tooltip lines describing what was executed at a point. */
export function describeMarkerCell(
  cell: TradeMarkerCell | null | undefined,
  money: (v: number) => string,
  maxLines = 4,
  options?: MarkerCellOptions,
): string[] {
  if (!cell || cell.trades.length === 0) return [];
  const shown = cell.trades.slice(0, maxLines);
  const lines: string[] = [];
  for (const t of shown) {
    lines.push(
      `${t.side === "buy" ? "▲ BUY" : "▼ SELL"} ${t.symbol} · ${
        Math.abs(Number(t.quantity) || 0)
      } @ ${money(Math.abs(Number(t.price) || 0))}`,
    );
    if (options?.commission) {
      lines.push(describeCommission(tradeCommission(t, options.model), money));
    }
  }
  const extra = cell.trades.length - shown.length;
  if (extra > 0) lines.push(`+${extra} more`);
  if (options?.commission && cell.trades.length > 1) {
    const total = cell.trades.reduce(
      (a, t) => a + tradeCommission(t, options.model).commission,
      0,
    );
    lines.push(`   Total fees ${money(total)}`);
  }
  return lines;
}
