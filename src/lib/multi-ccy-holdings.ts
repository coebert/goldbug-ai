// Value a list of holdings that may be priced in several currencies into a
// single base currency (the portfolio's `currency` / base_ccy).
//
// This is a pure function: callers pass the holdings + prices + an FX
// resolver (usually backed by `getFxMatrix`). Keeping it pure means the
// Phase B executor, the equity-snapshot writer, and the card renderer can
// all share the same valuation without duplicating "when do I convert?"
// logic. Every caller must convert at snapshot time so equity numbers are
// comparable across portfolios and time.

export type MultiCcyHolding = {
  symbol: string;
  quantity: number;
  /** Per-unit price in the instrument's own currency. */
  price: number;
  /** Currency the price is quoted in (e.g. "USD" for AAPL). */
  instrument_ccy: string;
};

export type MultiCcyWallet = Record<string, number>; // { GBP: 1234.56, USD: 890 }

export type FxLookup = (from: string, to: string) => number;

export type ValuationBreakdown = {
  /** Holdings market value in base currency. */
  holdingsBaseCcy: number;
  /** Cash total across all wallet currencies, in base currency. */
  cashBaseCcy: number;
  /** holdingsBaseCcy + cashBaseCcy. */
  totalBaseCcy: number;
  /** Per-currency breakdown for the Errors/Audit tabs. */
  byCurrency: Record<string, { holdings: number; cash: number; total: number }>;
  /** True if any conversion used an identity / fallback / stale rate. */
  usedStaleRate: boolean;
  staleRatePairs: string[];
};

/**
 * Value everything into `baseCcy`. `fx(from, to)` returns the multiplier so
 * that `amount_from * fx(from, to) === amount_to`. `fx(x, x)` must return 1.
 *
 * If a rate is missing (NaN / 0 / undefined) we treat it as 1 and flag the
 * result as stale — this mirrors the fx.server fallback and lets the UI
 * show a warning without crashing the equity card.
 */
export function valueHoldings(
  holdings: MultiCcyHolding[],
  wallet: MultiCcyWallet,
  baseCcy: string,
  fx: FxLookup,
  isRateStale?: (from: string, to: string) => boolean,
): ValuationBreakdown {
  const base = baseCcy.toUpperCase();
  const byCurrency: Record<string, { holdings: number; cash: number; total: number }> = {};
  const staleRatePairs: string[] = [];
  let usedStale = false;

  const bucket = (ccy: string) => {
    const k = ccy.toUpperCase();
    if (!byCurrency[k]) byCurrency[k] = { holdings: 0, cash: 0, total: 0 };
    return byCurrency[k];
  };

  const safeRate = (from: string, to: string) => {
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    if (f === t) return 1;
    const raw = fx(f, t);
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      usedStale = true;
      staleRatePairs.push(`${f}${t}`);
      return 1;
    }
    if (isRateStale?.(f, t)) {
      usedStale = true;
      staleRatePairs.push(`${f}${t}`);
    }
    return raw;
  };

  let holdingsBase = 0;
  for (const h of holdings) {
    const q = Number(h.quantity);
    const p = Number(h.price);
    if (!Number.isFinite(q) || !Number.isFinite(p)) continue;
    const nativeValue = q * p;
    const b = bucket(h.instrument_ccy);
    b.holdings += nativeValue;
    b.total += nativeValue;
    holdingsBase += nativeValue * safeRate(h.instrument_ccy, base);
  }

  let cashBase = 0;
  for (const [ccy, amt] of Object.entries(wallet || {})) {
    const v = Number(amt);
    if (!Number.isFinite(v)) continue;
    const b = bucket(ccy);
    b.cash += v;
    b.total += v;
    cashBase += v * safeRate(ccy, base);
  }

  return {
    holdingsBaseCcy: holdingsBase,
    cashBaseCcy: cashBase,
    totalBaseCcy: holdingsBase + cashBase,
    byCurrency,
    usedStaleRate: usedStale,
    staleRatePairs: [...new Set(staleRatePairs)],
  };
}
