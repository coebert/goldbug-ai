// Server-side adapter around the pure valuation kernel.
//
// Most callers already hold a price map that has been through
// `normalizeMarketPriceForTrading` (so LSE pence are already GBP) but has NOT
// been FX-converted — that missing second half is what produced totals where
// USD positions were counted 1:1 as GBP. This adapter fetches the FX rates the
// holdings actually need and runs the kernel once, with the unit divisor
// suppressed so already-normalised prices are not divided twice.

import { getFxRate } from "../fx.server";
import { normalizeLseDisplayPriceToBase } from "../market-price-units";
import { priceSymbolVariants } from "../price-symbol";
import {
  computeValuation,
  majorUnitCurrency,
  type KernelHolding,
  type KernelWallet,
  type ValuationResult,
} from "./kernel";

export type ValueHoldingsInput = {
  holdings: KernelHolding[];
  /**
   * Prices already normalised into the instrument's MAJOR unit (GBP not GBX),
   * keyed by any casing/variant of the holding symbol.
   */
  normalizedPrices: Map<string, number> | Record<string, number>;
  /** Cash by currency. Pass `{ [baseCcy]: cash }` for single-wallet portfolios. */
  wallet: KernelWallet;
  baseCcy: string;
  asOf?: string;
  allowCostBasisFallback?: boolean;
};

function priceReader(src: ValueHoldingsInput["normalizedPrices"]) {
  const map =
    src instanceof Map ? src : new Map(Object.entries(src ?? {}).map(([k, v]) => [k, Number(v)]));
  return (symbol: string): number | null => {
    for (const key of [symbol, symbol.toUpperCase(), symbol.toLowerCase(), ...priceSymbolVariants(symbol)]) {
      const v = map.get(key);
      if (v != null && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };
}

/** Fetch every rate needed to bring `currencies` into `base`. */
export async function loadFxRates(
  currencies: Iterable<string>,
  base: string,
): Promise<Map<string, number>> {
  const to = base.toUpperCase();
  const out = new Map<string, number>();
  const wanted = [...new Set([...currencies].map((c) => c.toUpperCase()))].filter(
    (c) => c && c !== to,
  );
  await Promise.all(
    wanted.map(async (from) => {
      try {
        const r = await getFxRate(from, to);
        if (r && Number.isFinite(r.rate) && r.rate > 0) out.set(`${from}>${to}`, r.rate);
      } catch {
        /* leave unset — the kernel flags the 1:1 fallback */
      }
    }),
  );
  return out;
}

/**
 * Value a portfolio into its base currency, applying FX to every non-base
 * holding and wallet balance. Returns the kernel result including provenance.
 */
export async function valuePortfolioHoldings(
  input: ValueHoldingsInput,
): Promise<ValuationResult> {
  const base = (input.baseCcy || "GBP").toUpperCase();
  const holdings = (input.holdings ?? []).map((h) => ({
    ...h,
    // Cost basis is stored in native quote units; bring it into major units so
    // the fallback path cannot reintroduce a 100x pence inflation.
    avg_cost:
      h.avg_cost == null
        ? null
        : normalizeLseDisplayPriceToBase(String(h.symbol), Number(h.avg_cost), h.asset_class ?? null),
  }));

  const currencies = new Set<string>([base]);
  for (const h of holdings) {
    currencies.add(majorUnitCurrency(String(h.symbol), h.instrument_ccy ?? null, base));
  }
  for (const ccy of Object.keys(input.wallet ?? {})) {
    currencies.add(ccy.toUpperCase() === "GBX" ? "GBP" : ccy.toUpperCase());
  }

  const rates = await loadFxRates(currencies, base);

  return computeValuation({
    holdings,
    wallet: input.wallet ?? {},
    baseCcy: base,
    price: priceReader(input.normalizedPrices),
    fx: (from, to) => (from === to ? 1 : (rates.get(`${from.toUpperCase()}>${to.toUpperCase()}`) ?? null)),
    // Prices are already in major units, so tell the kernel not to divide.
    observedQuoteCcy: (symbol) => {
      const h = holdings.find((x) => String(x.symbol).toUpperCase() === symbol.toUpperCase());
      return majorUnitCurrency(symbol, h?.instrument_ccy ?? null, base);
    },
    asOf: input.asOf,
    allowCostBasisFallback: input.allowCostBasisFallback,
  });
}
