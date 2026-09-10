// Diversified-fund classification for the single-name concentration cap.
//
// The 15% single-name cap exists because one mid-cap retailer was nibbled to
// 31% of a £10k book. That reasoning is about IDIOSYNCRATIC risk: one company
// failing. A broad index fund (VWRL, VUSA, ISF) is not one company — applying
// the same cap to it means a small account can never actually be invested,
// which was the single biggest drag found in the account review.
//
// So broad, physically diversified index funds get a higher cap. Anything that
// concentrates risk again — inverse/leveraged/daily-reset products, single
// commodities, single-sector or single-country thematic funds — stays on the
// ordinary single-name cap.
//
// Pure module: no I/O, safe to unit test.

/** Cap for a broad diversified index fund, as a fraction of NAV. */
export const DEFAULT_MAX_DIVERSIFIED_POSITION_PCT_OF_NAV = 0.35;

/** Symbols known to be broad, multi-hundred-holding index trackers. */
const BROAD_FUND_SYMBOLS = new Set([
  "VWRL.L", "VWRP.L", "VEVE.L", "VUSA.L", "VUAG.L", "VMID.L", "VUKE.L",
  "ISF.L", "IWDA.L", "SWDA.L", "CSP1.L", "EQQQ.L", "AGGU.L",
  "SPY", "VOO", "VTI", "IVV", "QQQ", "VT", "VXUS", "SCHB", "ITOT",
  "1321.T", "1306.T", "STW.AX", "IOZ.AX",
]);

/** Words that mean the fund re-concentrates risk — never widened. */
const CONCENTRATING_HINTS = [
  "short", "inverse", "bear", "leverag", "2x", "3x", "daily",
  "gold", "silver", "oil", "gas", "bitcoin", "crypto", "uranium",
  "sector", "thematic", "biotech", "semiconductor", "cannabis",
];

export type DiversifiedFundInput = {
  symbol: string;
  /** Universe asset class when known ("etf", "stock", …). */
  assetClass?: string | null;
  /** Instrument name when known — used to spot concentrating products. */
  name?: string | null;
};

/**
 * True when the instrument is a broad diversified fund that should sit under
 * the wider position cap rather than the single-name cap.
 */
export function isDiversifiedFund(input: DiversifiedFundInput): boolean {
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!symbol) return false;
  const name = String(input.name ?? "").toLowerCase();
  if (CONCENTRATING_HINTS.some((h) => name.includes(h))) return false;

  const base = symbol.split(":")[0] ?? symbol;
  if (BROAD_FUND_SYMBOLS.has(base)) return true;

  // Unknown ETFs are only widened when nothing in the name suggests a
  // concentrated product; an unnamed unknown ETF stays on the tight cap.
  const cls = String(input.assetClass ?? "").trim().toLowerCase();
  if (cls !== "etf") return false;
  if (!name) return false;
  return /index|all[- ]world|world|global|s&p|ftse|msci|nasdaq 100|total market|core/.test(name);
}

/**
 * Position cap for one candidate, as a fraction of NAV.
 */
export function positionCapPctFor(
  diversified: boolean | undefined,
  singleNamePct: number,
  diversifiedPct: number = DEFAULT_MAX_DIVERSIFIED_POSITION_PCT_OF_NAV,
): number {
  if (!diversified) return singleNamePct;
  return Math.max(singleNamePct, diversifiedPct);
}
