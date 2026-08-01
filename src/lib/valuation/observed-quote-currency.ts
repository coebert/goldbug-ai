// Observed quote-currency store.
//
// The GBX-vs-GBP decision used to rest entirely on a hand-maintained allowlist
// of tickers. Widening that list was never going to end: every new LSE listing
// is a coin flip until someone notices a 100x tile.
//
// Instead, when a price is fetched we record the currency the feed actually
// quoted the symbol in. The valuation kernel prefers that recorded fact and
// only falls back to the heuristic for symbols we have never priced.
//
// A second safeguard sits alongside it: `detectUnitFlip` compares a new quote
// against the trailing median for the same symbol and flags a 50-200x move,
// which is a unit flip rather than a market event. That check runs BEFORE the
// quote is multiplied by a quantity.

export type ObservedQuoteRow = {
  symbol: string;
  quote_currency: string;
  observed_at: string;
  sample_price: number | null;
  source: string | null;
};

type MinimalClient = { from: (table: string) => any };

const TABLE = "observed_quote_currency";

/** Minor-unit (1/100th) quote currencies, canonicalised. */
export const MINOR_UNIT_CURRENCIES = new Set(["GBX", "ZAC", "ILA"]);

/** Canonicalise a feed currency, preserving the major/minor distinction. */
export function canonicalQuoteCurrency(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s === "GBp" || s.toUpperCase() === "GBX") return "GBX";
  if (s === "ZAc" || s.toUpperCase() === "ZAC") return "ZAC";
  if (s === "ILa" || s.toUpperCase() === "ILA") return "ILA";
  return s.toUpperCase();
}

/** True when quotes in `ccy` are 1/100th of the major unit. */
export function isMinorUnitCurrency(ccy: string | null | undefined): boolean {
  return MINOR_UNIT_CURRENCIES.has(canonicalQuoteCurrency(ccy));
}

/** The major currency a (possibly minor-unit) quote currency belongs to. */
export function majorOf(ccy: string | null | undefined): string {
  const c = canonicalQuoteCurrency(ccy);
  if (c === "GBX") return "GBP";
  if (c === "ZAC") return "ZAR";
  if (c === "ILA") return "ILS";
  return c;
}

/** Record (or refresh) the currency a feed quoted `symbol` in. */
export async function recordObservedQuoteCurrency(
  client: MinimalClient,
  entry: { symbol: string; quoteCurrency: string; samplePrice?: number | null; source?: string },
): Promise<void> {
  const symbol = String(entry.symbol ?? "").trim().toUpperCase();
  // Yahoo signals pence with the casing "GBp" (and agorot/cents similarly).
  // Canonicalise minor units to their ISO-ish minor code BEFORE uppercasing,
  // otherwise the distinction that matters is destroyed.
  const ccy = canonicalQuoteCurrency(entry.quoteCurrency);
  if (!symbol || !ccy) return;
  try {
    await client.from(TABLE).upsert(
      {
        symbol,
        quote_currency: ccy,
        observed_at: new Date().toISOString(),
        sample_price: entry.samplePrice ?? null,
        source: entry.source ?? null,
      },
      { onConflict: "symbol" },
    );
  } catch {
    /* observation is best-effort; never break a price fetch */
  }
}

/** Load the observed currencies for a set of symbols as a lookup function. */
export async function loadObservedQuoteCurrencies(
  client: MinimalClient,
  symbols: string[],
): Promise<(symbol: string) => string | null> {
  const wanted = [...new Set(symbols.map((s) => String(s ?? "").trim().toUpperCase()))].filter(Boolean);
  if (wanted.length === 0) return () => null;
  const map = new Map<string, string>();
  try {
    const { data } = await client.from(TABLE).select("symbol, quote_currency").in("symbol", wanted);
    for (const row of (data ?? []) as ObservedQuoteRow[]) {
      map.set(String(row.symbol).toUpperCase(), String(row.quote_currency).toUpperCase());
    }
  } catch {
    /* fall back to the heuristic */
  }
  return (symbol: string) => map.get(String(symbol ?? "").trim().toUpperCase()) ?? null;
}

/** Lower/upper bounds of the "this is a unit flip, not a price move" band. */
export const UNIT_FLIP_MIN = 50;
export const UNIT_FLIP_MAX = 200;

export type UnitFlip = {
  symbol: string;
  quote: number;
  median: number;
  ratio: number;
  direction: "inflated" | "deflated";
};

/**
 * Compare a fresh quote against the trailing median for the same symbol.
 * A ratio inside [50, 200] (either direction) is a currency-unit flip — no
 * real instrument moves by that much between two consecutive observations.
 */
export function detectUnitFlip(
  symbol: string,
  quote: number,
  recentQuotes: number[],
): UnitFlip | null {
  const clean = recentQuotes.map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (clean.length < 3 || !Number.isFinite(quote) || quote <= 0) return null;
  const mid = clean.length % 2
    ? clean[(clean.length - 1) / 2]!
    : (clean[clean.length / 2 - 1]! + clean[clean.length / 2]!) / 2;
  if (mid <= 0) return null;

  const up = quote / mid;
  if (up >= UNIT_FLIP_MIN && up <= UNIT_FLIP_MAX) {
    return { symbol, quote, median: mid, ratio: up, direction: "inflated" };
  }
  const down = mid / quote;
  if (down >= UNIT_FLIP_MIN && down <= UNIT_FLIP_MAX) {
    return { symbol, quote, median: mid, ratio: down, direction: "deflated" };
  }
  return null;
}
