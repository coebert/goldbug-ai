// Per-holding currency risk.
//
// The multi-currency card answers "how much sits in each currency"; this one
// answers "which positions actually move when the exchange rate moves". A
// holding priced in a foreign currency carries two bets: the instrument and
// the FX pair. Any open funding leg that bought that currency offsets part of
// it, so hedge cover is shared across the holdings in that currency pro rata.
//
// Pure module: no IO, no clock beyond what is passed in.

export type CurrencyRiskHoldingInput = {
  symbol: string;
  /** Currency the instrument is priced and settled in. */
  currency: string;
  /** Market value of the position, converted to the portfolio base currency. */
  valueBase: number;
};

export type CurrencyRiskInput = {
  baseCcy: string;
  holdings: CurrencyRiskHoldingInput[];
  /** Total portfolio equity in base ccy — used for share-of-account figures. */
  equityBase: number;
  /** Daily volatility of ccy→base, as a fraction (0.005 = 0.5% a day). */
  dailyVolByCcy: Record<string, number>;
  /** Open FX funding cover per currency, in base ccy (absolute value). */
  hedgedBaseByCcy?: Record<string, number>;
};

export type CurrencyRiskBand = "none" | "low" | "medium" | "high";

export type HoldingCurrencyRiskRow = {
  symbol: string;
  currency: string;
  valueBase: number;
  /** Share of total account equity this position represents. */
  pctOfEquity: number;
  /** Value still exposed to the exchange rate after funding cover. */
  unhedgedBase: number;
  /** 0-1 share of the position covered by an open funding leg. */
  hedgedShare: number;
  dailyVolPct: number;
  /** One-day 95% move on the unhedged part, in base ccy (always positive). */
  oneDayVarBase: number;
  /** What a 5% adverse move in the pair costs, in base ccy. */
  adverse5PctBase: number;
  band: CurrencyRiskBand;
};

export type HoldingCurrencyRiskResult = {
  baseCcy: string;
  rows: HoldingCurrencyRiskRow[];
  /** Value in currencies other than base, before hedges. */
  foreignValueBase: number;
  /** Value in currencies other than base, after hedges. */
  unhedgedValueBase: number;
  foreignPctOfEquity: number;
  unhedgedPctOfEquity: number;
  /** Total one-day 95% currency move across every position. */
  totalOneDayVarBase: number;
  totalAdverse5PctBase: number;
  /** Currency with the largest unhedged exposure, if any. */
  topCurrency: string | null;
};

/** 95% one-tailed normal multiple, the usual desk convention. */
const Z95 = 1.645;

/**
 * Fallback daily vols when no rate history is available. Deliberately mid-range
 * so a missing history makes the risk look real rather than zero.
 */
export const FALLBACK_DAILY_VOL: Record<string, number> = {
  USD: 0.005,
  EUR: 0.004,
  CHF: 0.005,
  JPY: 0.006,
  SEK: 0.006,
  NOK: 0.007,
  DKK: 0.004,
  AUD: 0.007,
  CAD: 0.005,
  HKD: 0.005,
  SGD: 0.004,
  GBP: 0.005,
};
const DEFAULT_DAILY_VOL = 0.006;

export function fallbackDailyVol(ccy: string): number {
  return FALLBACK_DAILY_VOL[ccy.toUpperCase()] ?? DEFAULT_DAILY_VOL;
}

/** Sample standard deviation of log returns from a daily rate series. */
export function dailyVolFromRates(rates: number[]): number | null {
  const usable = rates.filter((r) => Number.isFinite(r) && r > 0);
  if (usable.length < 10) return null;
  const rets: number[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    rets.push(Math.log(usable[i]! / usable[i - 1]!));
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  const vol = Math.sqrt(Math.max(0, variance));
  return Number.isFinite(vol) && vol > 0 ? vol : null;
}

function bandFor(varShareOfEquity: number, unhedgedBase: number): CurrencyRiskBand {
  if (unhedgedBase <= 0) return "none";
  if (varShareOfEquity >= 0.005) return "high";
  if (varShareOfEquity >= 0.002) return "medium";
  return "low";
}

export function buildHoldingCurrencyRisk(
  input: CurrencyRiskInput,
): HoldingCurrencyRiskResult {
  const base = input.baseCcy.toUpperCase();
  const equity = Number.isFinite(input.equityBase) && input.equityBase > 0
    ? input.equityBase
    : 0;

  // Total foreign value per currency, so hedge cover can be shared pro rata.
  const valueByCcy = new Map<string, number>();
  for (const h of input.holdings) {
    const ccy = h.currency.toUpperCase();
    if (ccy === base) continue;
    const v = Math.abs(Number(h.valueBase) || 0);
    valueByCcy.set(ccy, (valueByCcy.get(ccy) ?? 0) + v);
  }

  const rows: HoldingCurrencyRiskRow[] = input.holdings.map((h) => {
    const ccy = h.currency.toUpperCase();
    const valueBase = Number(h.valueBase) || 0;
    const magnitude = Math.abs(valueBase);
    if (ccy === base || magnitude === 0) {
      return {
        symbol: h.symbol,
        currency: ccy,
        valueBase,
        pctOfEquity: equity > 0 ? valueBase / equity : 0,
        unhedgedBase: 0,
        hedgedShare: ccy === base ? 1 : 0,
        dailyVolPct: 0,
        oneDayVarBase: 0,
        adverse5PctBase: 0,
        band: "none",
      };
    }

    const ccyTotal = valueByCcy.get(ccy) ?? magnitude;
    const hedgeForCcy = Math.max(0, Number(input.hedgedBaseByCcy?.[ccy] ?? 0));
    // Share the leg out by size: one leg often funds several positions.
    const share = ccyTotal > 0 ? magnitude / ccyTotal : 0;
    const hedgedBase = Math.min(magnitude, hedgeForCcy * share);
    const unhedgedBase = Math.max(0, magnitude - hedgedBase);
    const hedgedShare = magnitude > 0 ? hedgedBase / magnitude : 0;

    const vol = Number(input.dailyVolByCcy[ccy]);
    const dailyVolPct = Number.isFinite(vol) && vol > 0 ? vol : fallbackDailyVol(ccy);
    const oneDayVarBase = unhedgedBase * dailyVolPct * Z95;
    const adverse5PctBase = unhedgedBase * 0.05;

    return {
      symbol: h.symbol,
      currency: ccy,
      valueBase,
      pctOfEquity: equity > 0 ? valueBase / equity : 0,
      unhedgedBase,
      hedgedShare,
      dailyVolPct,
      oneDayVarBase,
      adverse5PctBase,
      band: bandFor(equity > 0 ? oneDayVarBase / equity : 0, unhedgedBase),
    };
  });

  rows.sort((a, b) => b.oneDayVarBase - a.oneDayVarBase || b.valueBase - a.valueBase);

  const foreignValueBase = rows
    .filter((r) => r.currency !== base)
    .reduce((a, r) => a + Math.abs(r.valueBase), 0);
  const unhedgedValueBase = rows.reduce((a, r) => a + r.unhedgedBase, 0);
  const totalOneDayVarBase = rows.reduce((a, r) => a + r.oneDayVarBase, 0);
  const totalAdverse5PctBase = rows.reduce((a, r) => a + r.adverse5PctBase, 0);

  const byCcyUnhedged = new Map<string, number>();
  for (const r of rows) {
    if (r.currency === base || r.unhedgedBase <= 0) continue;
    byCcyUnhedged.set(r.currency, (byCcyUnhedged.get(r.currency) ?? 0) + r.unhedgedBase);
  }
  const topCurrency =
    [...byCcyUnhedged.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    baseCcy: base,
    rows,
    foreignValueBase,
    unhedgedValueBase,
    foreignPctOfEquity: equity > 0 ? foreignValueBase / equity : 0,
    unhedgedPctOfEquity: equity > 0 ? unhedgedValueBase / equity : 0,
    totalOneDayVarBase,
    totalAdverse5PctBase,
    topCurrency,
  };
}
