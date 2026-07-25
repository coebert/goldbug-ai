// Shared money formatter for the home-page portfolio cards.
//
// Locks the on-screen number shape so every card renders GBP (and any
// other currency the portfolio uses) with the same rounding rule,
// fraction digits, and thousands separators. Centralising this means
// the headline £ value can never drift from the smaller "cash" line
// or the tests that assert against them.
//
// Contract:
//   - Always exactly 2 fraction digits (min = max = 2).
//   - Rounding mode: halfExpand (banker-neutral, matches how humans
//     read a ledger — 0.005 → 0.01, -0.005 → -0.01).
//   - en-GB grouping (thousands separators via commas).
//   - Non-finite / null inputs → "—" so the layout never breaks.
//   - -0 is coerced to 0 to avoid a stray "-0.00" leaking through.

const MONEY_FMT = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: true,
  // Cast: `roundingMode` is a valid Intl option but not yet in every
  // TS lib version we ship against.
  roundingMode: "halfExpand",
} as Intl.NumberFormatOptions);

// Cache formatters for user-configurable decimal counts (0–4). Building an
// Intl.NumberFormat per render is cheap-but-wasteful, so memoise by digits.
const FMT_CACHE = new Map<number, Intl.NumberFormat>();
function fmtFor(digits: number): Intl.NumberFormat {
  const d = Math.max(0, Math.min(4, Math.trunc(digits)));
  let f = FMT_CACHE.get(d);
  if (!f) {
    f = new Intl.NumberFormat("en-GB", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
      useGrouping: true,
      roundingMode: "halfExpand",
    } as Intl.NumberFormatOptions);
    FMT_CACHE.set(d, f);
  }
  return f;
}

/** Format a bare number as "1,234.50" (no currency prefix). */
export function formatMoneyAmount(
  value: number | null | undefined,
  fractionDigits?: number,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const fmt = fractionDigits == null ? MONEY_FMT : fmtFor(fractionDigits);
  const out = fmt.format(value === 0 ? 0 : value);
  // Strip a "-" prefix that only sits in front of an all-zero body
  // (e.g. -0.0001 rounds to "-0.00" — we render it as "0.00").
  return /^-0\.?0*$|^-0$/.test(out) ? out.slice(1) : out;
}

/**
 * Format a value with its currency prefix, e.g. "GBP 1,234.50".
 * Prefix defaults to "GBP" — pass the portfolio's currency to keep
 * the card honest for non-sterling accounts.
 */
export function formatMoney(
  value: number | null | undefined,
  currency: string = "GBP",
  fractionDigits?: number,
): string {
  const body = formatMoneyAmount(value, fractionDigits);
  return body === "—" ? "—" : `${currency} ${body}`;
}

