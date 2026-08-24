// The single valuation kernel.
//
// This is the ONLY place in the app that turns holdings + prices + cash into
// an equity figure. Everything else — the trading engine, the broker syncs,
// the backfill/revalue jobs, the diagnostics panels — calls `computeValuation`
// and writes the result through `valuation/write-snapshot.server.ts`.
//
// Why one kernel: the app previously had seven independent snapshot writers,
// each with its own copy of "when do I divide by 100?" and "do I apply FX?".
// Two of them (the trading engine) did a bare `price * quantity` sum, which is
// the origin of both the GBX pence-inflation and the USD-counted-as-GBP
// incidents. Fixing them one at a time never held, because the next writer
// still had its own arithmetic.
//
// This module is PURE: no I/O, no Supabase, no fetch. Callers pass in the
// price map and an FX resolver. That keeps it testable in any environment and
// makes the golden-file suite meaningful.

import { instrumentCcyFor, venueCurrency } from "../instrument-ccy-rules";
import { isLseGbxDisplayQuoted } from "../market-price-units";
import { priceSymbolVariants } from "../price-symbol";
import { holdingNativeValue } from "../fx-leg-value";


export type KernelHolding = {
  symbol: string;
  quantity: number | string;
  /** Stored tag, if any. The rules layer normalises/overrides bad tags. */
  instrument_ccy?: string | null;
  /** Cost basis in the instrument's native quote units (GBX for LSE stocks). */
  avg_cost?: number | string | null;
  asset_class?: string | null;
};

/** Wallet balances keyed by currency: `{ GBP: 1234.56, USD: 890 }`. */
export type KernelWallet = Record<string, number>;

/** Returns the raw native quote for a symbol, or null when unknown. */
export type PriceLookup = (symbol: string) => number | null | undefined;

/** Returns the multiplier such that `amount_from * fx(from, to) === amount_to`. */
export type FxResolve = (from: string, to: string) => number | null | undefined;

/**
 * Quote currency observed on the wire for a symbol (see the observed-quote
 * store). Preferred over the heuristic allowlist when present.
 */
export type ObservedQuoteCcy = (symbol: string) => string | null | undefined;

export type PriceSource = "market" | "cost_basis" | "missing" | "unresolved_units";

/** Outcome of deciding what units a raw quote arrives in. */
export type QuoteUnits = {
  quoteCurrency: string;
  quoteCurrencySource: "observed" | "rules" | "unresolved";
  /** 100 for GBX, otherwise 1. Meaningless when `resolved` is false. */
  unitDivisor: number;
  instrumentCurrency: string;
  /** False when GBX vs GBP (or any currency) could not be determined. */
  resolved: boolean;
  unresolvedReason?: string;
};
export type FxSource = "identity" | "resolved" | "fallback_identity";

/** Per-holding provenance: everything needed to explain one line of a total. */
export type ValuationLine = {
  symbol: string;
  /** The key the price was actually found under (or the resolved key tried). */
  priceKey: string;
  quantity: number;
  /** Raw quote as supplied, before any unit divisor. */
  nativeQuote: number;
  /** Currency the raw quote is expressed in ("GBX" for pence-quoted LSE). */
  quoteCurrency: string;
  /** How the quote currency was decided. */
  quoteCurrencySource: "observed" | "rules" | "unresolved";
  /** False when the quote units could not be decided; value withheld. */
  unitsResolved: boolean;
  /** 100 for GBX, otherwise 1. */
  unitDivisor: number;
  /** Currency after the divisor is applied (GBX -> GBP). */
  instrumentCurrency: string;
  /** quantity * nativeQuote / unitDivisor, in `instrumentCurrency`. */
  nativeValue: number;
  fxRate: number;
  fxSource: FxSource;
  /** nativeValue * fxRate, in the portfolio's base currency. */
  baseValue: number;
  priceSource: PriceSource;
};

export type ValuationCashLine = {
  currency: string;
  amount: number;
  fxRate: number;
  fxSource: FxSource;
  baseValue: number;
};

export type ValuationWarningCode =
  | "missing_price"
  | "cost_basis_fallback"
  | "missing_fx_rate"
  | "unresolved_quote_units"
  | "non_finite_input";

export type ValuationWarning = {
  code: ValuationWarningCode;
  symbol?: string;
  pair?: string;
  message: string;
};

export type ValuationProvenance = {
  asOf: string;
  baseCurrency: string;
  lines: ValuationLine[];
  cash: ValuationCashLine[];
  warnings: ValuationWarning[];
  /** True when any figure leaned on a 1:1 fallback or a cost-basis price. */
  degraded: boolean;
};

export type ValuationResult = {
  /** Market value of all holdings, in base currency. */
  holdingsValue: number;
  /** Total cash across every wallet currency, in base currency. */
  cash: number;
  /** holdingsValue + cash. */
  totalValue: number;
  baseCurrency: string;
  provenance: ValuationProvenance;
};

export type ComputeValuationInput = {
  holdings: KernelHolding[];
  wallet: KernelWallet;
  baseCcy: string;
  price: PriceLookup;
  fx: FxResolve;
  observedQuoteCcy?: ObservedQuoteCcy;
  /** ISO timestamp this valuation represents. Defaults to now. */
  asOf?: string;
  /**
   * Allow `avg_cost` to stand in when no market price is available. Defaults
   * to true (matching the backfill path) but always emits a warning and marks
   * the result degraded.
   */
  allowCostBasisFallback?: boolean;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Decide the currency a raw quote for `symbol` arrives in, and the divisor
 * needed to bring it into that currency's major unit.
 *
 * Precedence:
 *   1. an observed quote currency recorded when the price was fetched
 *   2. the venue rules layer (`instrument-ccy-rules`) plus the GBX heuristic
 */
export function resolveQuoteUnits(
  symbol: string,
  declaredCcy: string | null | undefined,
  observed: string | null | undefined,
  defaultCcy: string,
): QuoteUnits {
  const obs = (observed ?? "").trim().toUpperCase();
  if (obs) {
    const divisor = obs === "GBX" ? 100 : 1;
    return {
      quoteCurrency: obs,
      quoteCurrencySource: "observed",
      unitDivisor: divisor,
      instrumentCurrency: obs === "GBX" ? "GBP" : obs,
      resolved: true,
    };
  }

  const declared = (declaredCcy ?? "").trim().toUpperCase();
  // A stored "GBX" tag is a unit statement, not a currency — honour it.
  if (declared === "GBX") {
    return {
      quoteCurrency: "GBX",
      quoteCurrencySource: "rules",
      unitDivisor: 100,
      instrumentCurrency: "GBP",
      resolved: true,
    };
  }

  if (isLseGbxDisplayQuoted(symbol)) {
    return {
      quoteCurrency: "GBX",
      quoteCurrencySource: "rules",
      unitDivisor: 100,
      instrumentCurrency: "GBP",
      resolved: true,
    };
  }

  // Nothing to go on: no observed quote currency, no stored tag, and the
  // symbol carries no venue marker the rules layer recognises. Guessing here
  // is exactly how a pence quote gets treated as pounds (or a USD quote as
  // GBP) and a tile reports a 100x or 25% wrong percentage. Report it as
  // unresolved and let callers withhold the number instead.
  if (!declared && !venueCurrency(symbol)) {
    return {
      quoteCurrency: "UNKNOWN",
      quoteCurrencySource: "unresolved",
      unitDivisor: 1,
      instrumentCurrency: (defaultCcy || "GBP").trim().toUpperCase(),
      resolved: false,
      unresolvedReason: `No observed quote currency, no stored instrument_ccy, and no recognised venue for "${String(symbol ?? "").trim() || "(blank symbol)"}" — GBX vs GBP cannot be decided.`,
    };
  }

  const ccy = instrumentCcyFor(symbol, declared || null, defaultCcy).toUpperCase();
  return {
    quoteCurrency: ccy,
    quoteCurrencySource: "rules",
    unitDivisor: 1,
    instrumentCurrency: ccy,
    resolved: true,
  };
}

/**
 * UI-facing predicate: can this row's quote units be decided at all?
 * Components use it to render "—" instead of a percentage that would be
 * silently off by 100x (or by an FX leg).
 */
export function quoteUnitsResolved(
  symbol: string,
  declaredCcy?: string | null,
  observed?: string | null,
  defaultCcy = "GBP",
): boolean {
  return resolveQuoteUnits(symbol, declaredCcy, observed, defaultCcy).resolved;
}


/** Look a price up under every key this holding might be cached under. */
function lookupPrice(price: PriceLookup, symbol: string): { value: number | null; key: string } {
  const variants = priceSymbolVariants(symbol);
  for (const key of variants) {
    const raw = num(price(key));
    if (Number.isFinite(raw) && raw > 0) return { value: raw, key };
  }
  return { value: null, key: variants[variants.length - 1] ?? String(symbol ?? "") };
}

export function computeValuation(input: ComputeValuationInput): ValuationResult {
  const base = (input.baseCcy || "GBP").trim().toUpperCase();
  const asOf = input.asOf ?? new Date().toISOString();
  const allowCostBasis = input.allowCostBasisFallback !== false;

  const warnings: ValuationWarning[] = [];
  const lines: ValuationLine[] = [];
  const cashLines: ValuationCashLine[] = [];
  let degraded = false;

  const rateFor = (from: string): { rate: number; source: FxSource } => {
    const f = (from || base).trim().toUpperCase();
    if (f === base) return { rate: 1, source: "identity" };
    const raw = num(input.fx(f, base));
    if (!Number.isFinite(raw) || raw <= 0) {
      degraded = true;
      warnings.push({
        code: "missing_fx_rate",
        pair: `${f}${base}`,
        message: `No FX rate for ${f}->${base}; treated as 1:1 and flagged.`,
      });
      return { rate: 1, source: "fallback_identity" };
    }
    return { rate: raw, source: "resolved" };
  };

  let holdingsValue = 0;
  for (const h of input.holdings ?? []) {
    const symbol = String(h.symbol ?? "").trim();
    if (!symbol) continue;

    const quantity = num(h.quantity);
    if (!Number.isFinite(quantity)) {
      degraded = true;
      warnings.push({
        code: "non_finite_input",
        symbol,
        message: `Quantity for ${symbol} is not a finite number; row skipped.`,
      });
      continue;
    }
    if (quantity === 0) continue;

    const units = resolveQuoteUnits(
      symbol,
      h.instrument_ccy,
      input.observedQuoteCcy?.(symbol),
      base,
    );

    const found = lookupPrice(input.price, symbol);

    // Fail safe: with no way to tell GBX from GBP (or from USD), any number we
    // produce is a coin flip between right and 100x wrong. Contribute nothing,
    // flag the result degraded, and record the raw quote for diagnostics so a
    // human (or the tagging job) can resolve the units.
    if (!units.resolved) {
      degraded = true;
      warnings.push({
        code: "unresolved_quote_units",
        symbol,
        message:
          units.unresolvedReason ??
          `Quote units for ${symbol} could not be resolved; row withheld from the total.`,
      });
      lines.push({
        symbol,
        priceKey: found.key,
        quantity,
        nativeQuote: found.value ?? 0,
        quoteCurrency: units.quoteCurrency,
        quoteCurrencySource: units.quoteCurrencySource,
        unitsResolved: false,
        unitDivisor: units.unitDivisor,
        instrumentCurrency: units.instrumentCurrency,
        nativeValue: 0,
        fxRate: 1,
        fxSource: "identity",
        baseValue: 0,
        priceSource: "unresolved_units",
      });
      continue;
    }

    let nativeQuote = found.value;
    let priceSource: PriceSource = "market";

    if (nativeQuote == null) {
      const cost = num(h.avg_cost);
      if (allowCostBasis && Number.isFinite(cost) && cost > 0) {
        // Cost basis is stored in the SAME native units as the quote, so the
        // divisor below still applies. Skipping it here is precisely the bug
        // that produced a GBP 817k headline on a GBP 10.2k account.
        nativeQuote = cost;
        priceSource = "cost_basis";
        degraded = true;
        warnings.push({
          code: "cost_basis_fallback",
          symbol,
          message: `No market price for ${symbol}; valued at cost basis.`,
        });
      } else {
        nativeQuote = 0;
        priceSource = "missing";
        degraded = true;
        warnings.push({
          code: "missing_price",
          symbol,
          message: `No price for ${symbol}; contributed 0 to holdings value.`,
        });
      }
    }

    // FX spot legs (broker funding conversions) contribute unrealised P&L
    // only — their notional is already represented by the cash wallet.
    const nativeValue =
      holdingNativeValue({
        assetClass: h.asset_class,
        quantity,
        price: nativeQuote,
        avgCost: num(h.avg_cost),
      }) / units.unitDivisor;

    const { rate, source } = rateFor(units.instrumentCurrency);
    const baseValue = nativeValue * rate;
    holdingsValue += baseValue;


    lines.push({
      symbol,
      priceKey: found.key,
      quantity,
      nativeQuote,
      quoteCurrency: units.quoteCurrency,
      quoteCurrencySource: units.quoteCurrencySource,
      unitsResolved: true,
      unitDivisor: units.unitDivisor,
      instrumentCurrency: units.instrumentCurrency,
      nativeValue,
      fxRate: rate,
      fxSource: source,
      baseValue,
      priceSource,
    });
  }

  let cash = 0;
  for (const [ccyRaw, amtRaw] of Object.entries(input.wallet ?? {})) {
    const amount = num(amtRaw);
    const currency = (ccyRaw || base).trim().toUpperCase();
    if (!Number.isFinite(amount)) {
      degraded = true;
      warnings.push({
        code: "non_finite_input",
        message: `Cash balance for ${currency} is not a finite number; skipped.`,
      });
      continue;
    }
    // GBX cash is a unit statement, same as quotes.
    const isGbx = currency === "GBX";
    const normalisedCcy = isGbx ? "GBP" : currency;
    const normalisedAmount = isGbx ? amount / 100 : amount;
    const { rate, source } = rateFor(normalisedCcy);
    const baseValue = normalisedAmount * rate;
    cash += baseValue;
    cashLines.push({ currency, amount, fxRate: rate, fxSource: source, baseValue });
  }

  holdingsValue = round2(holdingsValue);
  cash = round2(cash);

  return {
    holdingsValue,
    cash,
    totalValue: round2(holdingsValue + cash),
    baseCurrency: base,
    provenance: {
      asOf,
      baseCurrency: base,
      lines,
      cash: cashLines,
      warnings,
      degraded,
    },
  };
}

/** Compact provenance suitable for storing on the snapshot row. */
export function compactProvenance(p: ValuationProvenance) {
  return {
    as_of: p.asOf,
    base: p.baseCurrency,
    degraded: p.degraded,
    lines: p.lines.map((l) => ({
      s: l.symbol,
      q: l.quantity,
      px: l.nativeQuote,
      qc: l.quoteCurrency,
      div: l.unitDivisor,
      ic: l.instrumentCurrency,
      fx: l.fxRate,
      fxs: l.fxSource,
      v: round2(l.baseValue),
      src: l.priceSource,
    })),
    cash: p.cash.map((c) => ({ c: c.currency, a: c.amount, fx: c.fxRate, v: round2(c.baseValue) })),
    warnings: p.warnings.map((w) => ({ code: w.code, symbol: w.symbol ?? null, pair: w.pair ?? null })),
  };
}

/**
 * The currency a symbol's value is expressed in once the unit divisor has
 * been applied (GBP for pence-quoted LSE lines). Callers that hold prices
 * which are ALREADY in major units pass this as `observedQuoteCcy` so the
 * kernel does not divide a second time.
 */
export function majorUnitCurrency(
  symbol: string,
  declaredCcy?: string | null,
  defaultCcy = "GBP",
): string {
  return resolveQuoteUnits(symbol, declaredCcy, null, defaultCcy).instrumentCurrency;
}
