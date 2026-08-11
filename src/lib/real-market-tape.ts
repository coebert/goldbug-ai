// Real-market price tape construction (pure).
//
// Turns per-symbol daily history from a market-data provider into the
// `BacktestBar[]` shape the backtest runner consumes, with explicit
// corporate-action handling:
//
//   - SPLITS      Provider `close` is already split-adjusted, but raw
//                 closes are not. `applySplitAdjustment` back-adjusts a
//                 raw series so a 4:1 split does not look like a -75% day.
//   - DIVIDENDS   Two modes. "total_return" uses the provider's adjusted
//                 close (dividends reinvested — the standard way to score
//                 a strategy against a benchmark). "price_return" trades
//                 the split-adjusted price only and credits cash dividends
//                 separately, which is what a real cash account sees.
//
// The tape is built on the intersection-with-forward-fill calendar: a bar
// exists for any date at least one symbol traded, and each symbol carries
// its last known close (no look-ahead — only past closes are carried).

import type { BacktestBar } from "./backtest-runner";

export type RawDailyBar = {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** Split-adjusted close as reported by the provider. */
  close: number;
  /** Split + dividend adjusted close (total-return series). */
  adjClose?: number | null;
  /** Traded volume in units, when available. */
  volume?: number | null;
  /** Session high/low in the same units as `close`, when the provider gives them. */
  high?: number | null;
  low?: number | null;
};

export type CorporateAction = {
  symbol: string;
  date: string;
  kind: "split" | "dividend";
  /** Split ratio (e.g. 4 for 4:1) or cash dividend per share. */
  value: number;
};

export type SymbolHistory = {
  symbol: string;
  bars: RawDailyBar[];
  splits?: CorporateAction[];
  dividends?: CorporateAction[];
};

export type PriceMode = "total_return" | "price_return";

/**
 * Back-adjust a RAW (unadjusted) close series for splits so the series is
 * continuous. Prices strictly before a split date are divided by the ratio.
 */
export function applySplitAdjustment(
  bars: readonly RawDailyBar[],
  splits: readonly CorporateAction[],
): RawDailyBar[] {
  if (splits.length === 0) return bars.map((b) => ({ ...b }));
  const sorted = [...splits].sort((a, b) => a.date.localeCompare(b.date));
  return bars.map((b) => {
    let factor = 1;
    for (const s of sorted) {
      if (b.date < s.date && s.value > 0) factor *= s.value;
    }
    return {
      ...b,
      close: factor === 1 ? b.close : b.close / factor,
      volume: b.volume != null && factor !== 1 ? b.volume * factor : (b.volume ?? null),
    };
  });
}

/** Price used for a bar under the selected corporate-action mode. */
export function barPrice(bar: RawDailyBar, mode: PriceMode): number {
  if (mode === "total_return" && bar.adjClose != null && bar.adjClose > 0) return bar.adjClose;
  return bar.close;
}

export type TapeBuild = {
  bars: BacktestBar[];
  /** Symbols that produced at least one usable close. */
  symbols: string[];
  /** Per-symbol count of forward-filled (non-trading / halted) bars. */
  filledBars: Record<string, number>;
  /** Corporate actions inside the tape window, for the report. */
  actions: CorporateAction[];
};

/**
 * Build a chronological tape from per-symbol histories. Dates are the union
 * of all symbols' trading days; gaps are forward-filled from the previous
 * known close. A symbol only enters the tape from its first real close.
 */
export function buildRealTape(
  histories: readonly SymbolHistory[],
  opts: { mode?: PriceMode; from?: string; to?: string } = {},
): TapeBuild {
  const mode = opts.mode ?? "total_return";
  const inWindow = (d: string) => (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to);

  const series = new Map<string, Map<string, number>>();
  const symbols: string[] = [];
  const actions: CorporateAction[] = [];
  const dates = new Set<string>();

  for (const h of histories) {
    const m = new Map<string, number>();
    for (const b of h.bars) {
      if (!inWindow(b.date)) continue;
      const p = barPrice(b, mode);
      if (!(p > 0) || !Number.isFinite(p)) continue;
      m.set(b.date, p);
      dates.add(b.date);
    }
    if (m.size === 0) continue;
    series.set(h.symbol, m);
    symbols.push(h.symbol);
    for (const a of [...(h.splits ?? []), ...(h.dividends ?? [])]) {
      if (inWindow(a.date)) actions.push(a);
    }
  }

  const ordered = [...dates].sort();
  const last = new Map<string, number>();
  const filledBars: Record<string, number> = Object.fromEntries(symbols.map((s) => [s, 0]));
  const bars: BacktestBar[] = [];

  for (const date of ordered) {
    const closes: Record<string, number> = {};
    for (const symbol of symbols) {
      const today = series.get(symbol)?.get(date);
      if (today != null) {
        last.set(symbol, today);
        closes[symbol] = today;
      } else {
        const prev = last.get(symbol);
        // No look-ahead: a symbol is absent until its first real close.
        if (prev == null) continue;
        closes[symbol] = prev;
        filledBars[symbol] = (filledBars[symbol] ?? 0) + 1;
      }
    }
    if (Object.keys(closes).length > 0) bars.push({ date, closes });
  }

  actions.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
  return { bars, symbols, filledBars, actions };
}

/**
 * Sanity gate for a real tape: flags implausible single-bar moves that in
 * practice mean an unhandled corporate action (split, consolidation, or a
 * currency-unit switch) rather than a genuine market move.
 */
export function detectUnhandledActions(
  bars: readonly BacktestBar[],
  opts: { jumpPct?: number } = {},
): Array<{ symbol: string; date: string; fromPrice: number; toPrice: number; movePct: number }> {
  const threshold = opts.jumpPct ?? 45;
  const prev = new Map<string, number>();
  const out: Array<{
    symbol: string;
    date: string;
    fromPrice: number;
    toPrice: number;
    movePct: number;
  }> = [];
  for (const bar of bars) {
    for (const [symbol, price] of Object.entries(bar.closes)) {
      const before = prev.get(symbol);
      if (before != null && before > 0) {
        const movePct = ((price - before) / before) * 100;
        if (Math.abs(movePct) >= threshold) {
          out.push({ symbol, date: bar.date, fromPrice: before, toPrice: price, movePct });
        }
      }
      prev.set(symbol, price);
    }
  }
  return out;
}

/**
 * Cash dividends earned over the tape for a constant-share position — used
 * to report the income the price-return arm gives up versus total return.
 */
export function dividendIncome(
  histories: readonly SymbolHistory[],
  shares: Record<string, number>,
): number {
  let total = 0;
  for (const h of histories) {
    const qty = shares[h.symbol] ?? 0;
    if (!(qty > 0)) continue;
    for (const d of h.dividends ?? []) total += qty * d.value;
  }
  return total;
}
