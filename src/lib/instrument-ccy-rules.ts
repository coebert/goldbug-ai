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

/** MIC code (`AAPL:xnas`, `XLON:MKS`, `MKS.XLON`) → settlement currency. */
export const MIC_CCY: Record<string, string> = {
  // UK & Ireland
  xlon: "GBP",
  xlom: "GBP",
  bate: "GBP",
  chix: "GBP",
  turq: "GBP",
  aimx: "GBP",
  xdub: "EUR",
  xmsm: "EUR",
  // Euro area
  xetr: "EUR",
  xfra: "EUR",
  xber: "EUR",
  xdus: "EUR",
  xham: "EUR",
  xhan: "EUR",
  xmun: "EUR",
  xstu: "EUR",
  xpar: "EUR",
  xams: "EUR",
  xmil: "EUR",
  xmad: "EUR",
  xbru: "EUR",
  xlis: "EUR",
  xhel: "EUR",
  xwbo: "EUR",
  xath: "EUR",
  xbrn: "CHF",
  xtal: "EUR",
  xris: "EUR",
  xlit: "EUR",
  xbrv: "EUR",
  // Rest of Europe
  xswx: "CHF",
  xvtx: "CHF",
  xsto: "SEK",
  xngm: "SEK",
  xcse: "DKK",
  xose: "NOK",
  xoslo: "NOK",
  xice: "ISK",
  xwar: "PLN",
  xpra: "CZK",
  xbud: "HUF",
  xbse: "RON",
  xist: "TRY",
  merk: "RUB",
  // Americas
  xnas: "USD",
  xngs: "USD",
  xnms: "USD",
  xncm: "USD",
  xnys: "USD",
  xnye: "USD",
  arcx: "USD",
  bats: "USD",
  batz: "USD",
  edgx: "USD",
  edga: "USD",
  iexg: "USD",
  xase: "USD",
  xcbo: "USD",
  ootc: "USD",
  xotc: "USD",
  psgm: "USD",
  pinx: "USD",
  xtse: "CAD",
  xtsx: "CAD",
  xtsc: "CAD",
  neoe: "CAD",
  xcnq: "CAD",
  xmex: "MXN",
  bvmf: "BRL",
  xbue: "ARS",
  xsgo: "CLP",
  xbog: "COP",
  xlim: "PEN",
  // Asia-Pacific
  xhkg: "HKD",
  xses: "SGD",
  xsgx: "SGD",
  xtks: "JPY",
  xjpx: "JPY",
  xngo: "JPY",
  xkrx: "KRW",
  xkos: "KRW",
  xkon: "KRW",
  xtai: "TWD",
  roco: "TWD",
  xshg: "CNY",
  xshe: "CNY",
  xbom: "INR",
  xnse: "INR",
  xidx: "IDR",
  xbkk: "THB",
  xkls: "MYR",
  xphs: "PHP",
  xstc: "VND",
  xhnx: "VND",
  xasx: "AUD",
  chia: "AUD",
  xnze: "NZD",
  // Middle East & Africa
  xtae: "ILS",
  xsau: "SAR",
  xdfm: "AED",
  xadsm: "AED",
  xads: "AED",
  dsmd: "QAR",
  xkuw: "KWD",
  xbah: "BHD",
  xmus: "OMR",
  xcai: "EGP",
  xjse: "ZAR",
  xnsa: "NGN",
  xnai: "KES",
  // Crypto / derivatives venues that settle in USD
  xcme: "USD",
  gmni: "USD",
  cbse: "USD",
};

/** Yahoo-style dot suffix (`ISF.L`) → settlement currency. */
export const SUFFIX_CCY: Record<string, string> = {
  // UK & Ireland
  L: "GBP",
  LON: "GBP",
  LSE: "GBP",
  IL: "USD",
  IR: "EUR",
  // Germany / Austria / Switzerland
  DE: "EUR",
  F: "EUR",
  BE: "EUR",
  BM: "EUR",
  DU: "EUR",
  HM: "EUR",
  HA: "EUR",
  MU: "EUR",
  SG: "EUR",
  VI: "EUR",
  SW: "CHF",
  EB: "CHF",
  // Rest of Europe
  PA: "EUR",
  AS: "EUR",
  MI: "EUR",
  MC: "EUR",
  BR: "EUR",
  LS: "EUR",
  HE: "EUR",
  AT: "EUR",
  TL: "EUR",
  RG: "EUR",
  VS: "EUR",
  ST: "SEK",
  NGM: "SEK",
  CO: "DKK",
  OL: "NOK",
  IC: "ISK",
  WA: "PLN",
  PR: "CZK",
  BD: "HUF",
  RO: "RON",
  IS: "TRY",
  ME: "RUB",
  // Americas
  TO: "CAD",
  V: "CAD",
  CN: "CAD",
  NE: "CAD",
  MX: "MXN",
  SA: "BRL",
  BA: "ARS",
  SN: "CLP",
  CL: "COP",
  LM: "PEN",
  // Asia-Pacific
  T: "JPY",
  HK: "HKD",
  SS: "CNY",
  SZ: "CNY",
  KS: "KRW",
  KQ: "KRW",
  TW: "TWD",
  TWO: "TWD",
  SI: "SGD",
  JK: "IDR",
  BK: "THB",
  KL: "MYR",
  PS: "PHP",
  VN: "VND",
  AX: "AUD",
  NZ: "NZD",
  NS: "INR",
  BO: "INR",
  // Middle East & Africa
  TA: "ILS",
  SR: "SAR",
  AE: "AED",
  QA: "QAR",
  KW: "KWD",
  CA: "EGP",
  JO: "ZAR",
  NG: "NGN",
};

/**
 * Bloomberg-style composite country code (`VOD LN Equity`, `AAPL US`) →
 * settlement currency. Saxo and several CSV exports use this form.
 */
export const BLOOMBERG_CCY: Record<string, string> = {
  LN: "GBP",
  ID: "EUR",
  GY: "EUR",
  GR: "EUR",
  FP: "EUR",
  NA: "EUR",
  IM: "EUR",
  SM: "EUR",
  BB: "EUR",
  PL: "EUR",
  AV: "EUR",
  GA: "EUR",
  FH: "EUR",
  SW: "CHF",
  VX: "CHF",
  SS: "SEK",
  DC: "DKK",
  NO: "NOK",
  PW: "PLN",
  CP: "CZK",
  HB: "HUF",
  TI: "TRY",
  US: "USD",
  UN: "USD",
  UQ: "USD",
  UW: "USD",
  UA: "USD",
  UR: "USD",
  CT: "CAD",
  CN: "CAD",
  MM: "MXN",
  BZ: "BRL",
  AR: "ARS",
  CI: "CLP",
  JT: "JPY",
  JP: "JPY",
  HK: "HKD",
  CH: "CNY",
  C1: "CNY",
  KS: "KRW",
  KP: "KRW",
  TT: "TWD",
  SP: "SGD",
  IJ: "IDR",
  TB: "THB",
  MK: "MYR",
  PM: "PHP",
  VM: "VND",
  IN: "INR",
  IB: "INR",
  AU: "AUD",
  NZ: "NZD",
  IT: "ILS",
  AB: "SAR",
  UH: "AED",
  DH: "AED",
  QD: "QAR",
  SJ: "ZAR",
};


/** Where a normalized currency came from — useful for audit output. */
export type CcyRuleSource =
  /** MIC suffix on the symbol (`:xnys`). */
  | "mic"
  /** Yahoo-style dot suffix (`.L`). */
  | "suffix"
  /** Bloomberg composite country code (`VOD LN Equity`). */
  | "composite"
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
  // Additional large-cap US listings seen in broker exports
  "BRK", "ABBV", "MRK", "CVX", "WMT", "BAC", "CRM", "ORCL", "AMD", "INTC",
  "NFLX", "ADBE", "CSCO", "DIS", "MCD", "NKE", "TXN", "QCOM", "IBM", "GE",
  "CAT", "BA", "GS", "MS", "WFC", "C", "T", "VZ", "PFE", "ABT", "TMO", "DHR",
  "LIN", "HON", "UPS", "LOW", "SBUX", "PM", "MDT", "AMGN", "PLTR", "UBER",
  // Broad ETF universe
  "VXUS", "VEA", "VWO", "VUG", "VTV", "VYM", "VIG", "VNQ", "BNDX", "AGG",
  "IEFA", "IEMG", "IJR", "IJH", "ITOT", "DIA", "IWM", "IWF", "IWD", "EFA",
  "EEM", "TLT", "IEF", "SHY", "LQD", "HYG", "TIP", "ARKK", "SOXX", "SMH",
  "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE",
  "SLVP", "IAU", "USO", "UNG", "VOOG", "VOOV", "SPLG", "SPTM",
]);

/** Common share-class markers that follow a dot but are not venue suffixes. */
const SHARE_CLASS = new Set(["A", "B", "C", "D", "U", "WS", "PR", "UN"]);

/** Fiat + crypto codes we accept as the quote leg of a pair. */
const PAIR_QUOTES = new Set([
  "USD", "GBP", "EUR", "CHF", "JPY", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK",
  "SGD", "HKD", "ZAR", "PLN", "TRY", "MXN", "BRL", "INR", "CNY", "KRW",
  "USDT", "USDC", "BTC", "ETH",
]);

/** Crypto/stablecoin quote leg → the fiat currency it values in. */
const PAIR_SETTLES: Record<string, string> = { USDT: "USD", USDC: "USD" };

function cleanCcy(value: unknown): string | null {
  const raw = String(value ?? "").trim().toUpperCase();
  return raw.length >= 3 && raw.length <= 8 ? raw : null;
}

/** Resolve the quote leg of an FX/crypto pair to a settlement currency. */
function pairCurrency(quote: string): string | null {
  if (!PAIR_QUOTES.has(quote)) return null;
  return PAIR_SETTLES[quote] ?? quote;
}

/**
 * Currency implied purely by the symbol, or null when the symbol says nothing.
 *
 * Understands, in order: FX/crypto pairs (`GBPUSD=X`, `BTC-USD`, `BTC/USDT`),
 * MIC markers in either order and with either separator (`MKS:xlon`,
 * `XLON:MKS`, `MKS.XLON`, `XLON/MKS`), Yahoo-style exchange suffixes
 * (`ISF.L`, `SAP.DE`), Bloomberg composite codes (`VOD LN Equity`), and finally
 * known US roots — including class shares such as `BRK.B`.
 */
export function venueCurrency(symbol: string): { currency: string; source: CcyRuleSource } | null {
  const s = String(symbol ?? "").trim().toUpperCase();
  if (!s) return null;

  // FX and crypto spot pairs.
  if (s.endsWith("=X")) return { currency: s.slice(0, -2).slice(-3) || "USD", source: "pair" };
  for (const sep of ["-", "/", "_"]) {
    const at = s.lastIndexOf(sep);
    if (at > 0) {
      const quote = pairCurrency(s.slice(at + 1));
      if (quote) return { currency: quote, source: "pair" };
    }
  }
  // Concatenated pairs (`BTCUSD`, `GBPUSD`) with no separator.
  if (/^[A-Z]{6,8}$/.test(s)) {
    for (const len of [4, 3]) {
      if (s.length <= len) continue;
      const quote = pairCurrency(s.slice(-len));
      const base = s.slice(0, -len);
      if (quote && base.length >= 3 && PAIR_QUOTES.has(base)) {
        return { currency: quote, source: "pair" };
      }
    }
  }

  // MIC markers: either side of `:`, `/` or `.`, in either order.
  const parts = s.split(/[:/.\s]+/).filter(Boolean);
  for (const part of parts) {
    const byMic = MIC_CCY[part.toLowerCase()];
    if (byMic) return { currency: byMic, source: "mic" };
  }

  // Bloomberg composite form: `VOD LN`, `AAPL US Equity`.
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const tail = words[words.length - 1] === "EQUITY" ? words[words.length - 2] : words[words.length - 1];
    const byComposite = tail ? BLOOMBERG_CCY[tail] : undefined;
    if (byComposite) return { currency: byComposite, source: "composite" };
  }

  // Yahoo-style exchange suffix on the last dot segment.
  const root = words[0] ?? s;
  const bare = root.includes(":") ? (root.split(":").pop() as string) : root;
  const segs = bare.split(".").filter(Boolean);
  if (segs.length > 1) {
    const last = segs[segs.length - 1] as string;
    const bySuffix = SUFFIX_CCY[last];
    if (bySuffix) return { currency: bySuffix, source: "suffix" };
    // Class share such as BRK.B — decide from the root instead.
    if (SHARE_CLASS.has(last) && US_ROOTS.has(segs[0] as string)) {
      return { currency: "USD", source: "known_root" };
    }
  }

  if (US_ROOTS.has(segs[0] as string)) return { currency: "USD", source: "known_root" };
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
