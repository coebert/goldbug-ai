// Instrument currency tagging rules.
//
// `instrument_ccy` decides whether a valuation path applies an FX leg. A US
// listing tagged GBP is never converted, so the tile reads ~1.3x low; a pence
// (GBX) tag double-counts the ÷100 fold. Both faults were introduced by import
// paths that copied the portfolio's base currency onto every new row.
//
// This module is the single place that decides a row's settlement currency
// from the instrument and its venue, so every writer (broker sync, engine
// rebuild, fills replay) tags rows identically and a bad tag cannot come back
// in through a new import.
//
// Pure: no I/O, no clock.

/** MIC suffix (`AAPL:xnas`) → settlement currency. */
export const MIC_CCY: Record<string, string> = {
  xlon: "GBP",
  xetr: "EUR",
  xfra: "EUR",
  xpar: "EUR",
  xams: "EUR",
  xmil: "EUR",
  xmad: "EUR",
  xbru: "EUR",
  xlis: "EUR",
  xdub: "EUR",
  xhel: "EUR",
  xswx: "CHF",
  xvtx: "CHF",
  xtse: "CAD",
  xtsx: "CAD",
  xhkg: "HKD",
  xtks: "JPY",
  xjpx: "JPY",
  xasx: "AUD",
  xnze: "NZD",
  xsto: "SEK",
  xcse: "DKK",
  xose: "NOK",
  xsgx: "SGD",
  xnas: "USD",
  xnys: "USD",
  arcx: "USD",
  bats: "USD",
  xase: "USD",
};

/** Yahoo-style dot suffix (`ISF.L`) → settlement currency. */
export const SUFFIX_CCY: Record<string, string> = {
  L: "GBP",
  LON: "GBP",
  IL: "USD",
  DE: "EUR",
  F: "EUR",
  PA: "EUR",
  AS: "EUR",
  MI: "EUR",
  MC: "EUR",
  BR: "EUR",
  LS: "EUR",
  VI: "EUR",
  HE: "EUR",
  IR: "EUR",
  SW: "CHF",
  T: "JPY",
  HK: "HKD",
  AX: "AUD",
  NZ: "NZD",
  TO: "CAD",
  V: "CAD",
  ST: "SEK",
  CO: "DKK",
  OL: "NOK",
  SI: "SGD",
  SA: "BRL",
  JO: "ZAR",
  NS: "INR",
  BO: "INR",
  TA: "ILS",
};

/** Where a normalized currency came from — useful for audit output. */
export type CcyRuleSource =
  /** MIC suffix on the symbol (`:xnys`). */
  | "mic"
  /** Yahoo-style dot suffix (`.L`). */
  | "suffix"
  /** Crypto or FX pair convention (`BTC-USD`, `GBPUSD=X`). */
  | "pair"
  /** Known symbol root with no venue marker (`AAPL`, `VTI`). */
  | "known_root"
  /** Kept the declared value because no rule contradicted it. */
  | "declared"
  /** Nothing matched — fell back to the default. */
  | "default";

export type CcyTagResult = {
  /** Currency the row should carry. Always a settlement currency, never GBX. */
  currency: string;
  source: CcyRuleSource;
  /** The value the row arrived with, uppercased; null when absent. */
  declared: string | null;
  /** True when the rules changed the declared value. */
  corrected: boolean;
  /** Plain-language reason, present only when `corrected`. */
  reason: string | null;
};

/** Quote units that are never valid settlement currencies. */
const QUOTE_UNITS = new Set(["GBX", "GBP0.01", "ZAC", "ILA"]);

/** Quote unit → the currency it settles in. */
const QUOTE_UNIT_CCY: Record<string, string> = { GBX: "GBP", "GBP0.01": "GBP", ZAC: "ZAR", ILA: "ILS" };

/** US-listed roots that commonly arrive with no venue marker at all. */
const US_ROOTS = new Set([
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "JPM", "JNJ",
  "V", "MA", "UNH", "XOM", "PG", "HD", "KO", "PEP", "COST", "AVGO", "LLY",
  "VTI", "VOO", "SPY", "QQQ", "VT", "BND", "IVV", "SCHD", "GLD", "SLV",
]);

function cleanCcy(value: unknown): string | null {
  const raw = String(value ?? "").trim().toUpperCase();
  return raw.length >= 3 && raw.length <= 8 ? raw : null;
}

/** Currency implied purely by the symbol, or null when the symbol says nothing. */
export function venueCurrency(symbol: string): { currency: string; source: CcyRuleSource } | null {
  const s = String(symbol ?? "").trim().toUpperCase();
  if (!s) return null;

  // FX and crypto spot pairs.
  if (s.endsWith("=X")) return { currency: s.slice(0, -2).slice(-3) || "USD", source: "pair" };
  const dash = s.lastIndexOf("-");
  if (dash > 0 && s.length - dash - 1 === 3) {
    return { currency: s.slice(dash + 1), source: "pair" };
  }

  const colon = s.lastIndexOf(":");
  if (colon > 0) {
    const mic = s.slice(colon + 1).toLowerCase();
    const byMic = MIC_CCY[mic];
    if (byMic) return { currency: byMic, source: "mic" };
  }

  const root = colon > 0 ? s.slice(0, colon) : s;
  const dot = root.lastIndexOf(".");
  if (dot > 0) {
    const bySuffix = SUFFIX_CCY[root.slice(dot + 1)];
    if (bySuffix) return { currency: bySuffix, source: "suffix" };
  }

  if (US_ROOTS.has(root)) return { currency: "USD", source: "known_root" };
  return null;
}

/**
 * Normalize the `instrument_ccy` for one row. The listing venue always wins:
 * a stored tag is only kept when the symbol carries no venue information.
 */
export function normalizeInstrumentCcy(
  symbol: string,
  declaredCcy?: string | null,
  options: { defaultCcy?: string } = {},
): CcyTagResult {
  const declared = cleanCcy(declaredCcy);
  const fallback = cleanCcy(options.defaultCcy) ?? "USD";
  const venue = venueCurrency(symbol);

  if (venue) {
    const corrected = declared !== venue.currency;
    return {
      currency: venue.currency,
      source: venue.source,
      declared,
      corrected,
      reason: corrected
        ? declared
          ? `${symbol} lists in ${venue.currency}; stored tag was ${declared}, which would ${declared === "GBX" ? "double-count the pence fold" : "skip or misprice the FX leg"}.`
          : `${symbol} lists in ${venue.currency}; the row had no currency tag.`
        : null,
    };
  }

  if (declared && QUOTE_UNITS.has(declared)) {
    const settled = QUOTE_UNIT_CCY[declared]!;
    return {
      currency: settled,
      source: "declared",
      declared,
      corrected: true,
      reason: `${declared} is a quote unit, not a settlement currency — stored as ${settled} so the ÷100 fold is applied once.`,
    };
  }

  if (declared) {
    return { currency: declared, source: "declared", declared, corrected: false, reason: null };
  }

  return {
    currency: fallback,
    source: "default",
    declared: null,
    corrected: true,
    reason: `No venue marker on ${symbol || "symbol"} and no stored tag — defaulted to ${fallback}.`,
  };
}

/** Convenience: just the currency string. */
export function instrumentCcyFor(
  symbol: string,
  declaredCcy?: string | null,
  defaultCcy?: string,
): string {
  return normalizeInstrumentCcy(symbol, declaredCcy, { defaultCcy: defaultCcy ?? "USD" }).currency;
}

/**
 * Apply the rules to any row headed for `holdings`/`trades`/`orders`. Returns a
 * new row with a normalized `instrument_ccy`; every writer should pass rows
 * through this so an import cannot reintroduce a bad tag.
 */
export function tagRowCurrency<T extends { symbol: string; instrument_ccy?: string | null }>(
  row: T,
  defaultCcy?: string,
): T & { instrument_ccy: string } {
  return {
    ...row,
    instrument_ccy: instrumentCcyFor(row.symbol, row.instrument_ccy ?? null, defaultCcy),
  };
}

/** Apply the rules to a batch and report what changed, for audit logging. */
export function tagRowsCurrency<T extends { symbol: string; instrument_ccy?: string | null }>(
  rows: T[],
  defaultCcy?: string,
): {
  rows: (T & { instrument_ccy: string })[];
  corrections: { symbol: string; from: string | null; to: string; reason: string }[];
} {
  const corrections: { symbol: string; from: string | null; to: string; reason: string }[] = [];
  const out = rows.map((row) => {
    const result = normalizeInstrumentCcy(row.symbol, row.instrument_ccy ?? null, {
      defaultCcy: defaultCcy ?? "USD",
    });
    if (result.corrected && result.reason) {
      corrections.push({
        symbol: row.symbol,
        from: result.declared,
        to: result.currency,
        reason: result.reason,
      });
    }
    return { ...row, instrument_ccy: result.currency };
  });
  return { rows: out, corrections };
}
