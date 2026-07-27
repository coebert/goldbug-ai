// Shared money formatter for every portfolio metric surface (home cards,
// portfolio page headline, LiveHoldingsCard tiles, per-position rows,
// multi-currency breakdown, equity-change breakdown).
//
// Locks the on-screen number shape so the headline £ value can never
// drift from the smaller lines or from the tests that assert against
// them.
//
// Contract:
//   - Always exactly 2 fraction digits (min = max = 2).
//   - Rounding mode: halfExpand (matches how humans read a ledger —
//     0.005 → 0.01, -0.005 → -0.01). All numeric rounding used to
//     produce the displayed values goes through `roundMoney` so the
//     display cannot disagree with what tests / server totals compare.
//   - en-GB grouping (thousands separators via commas).
//   - Non-finite / null inputs → "—" so the layout never breaks.
//   - -0 is coerced to 0 to avoid a stray "-0.00" leaking through.
//   - `normalizeGbxToBase` folds GBX / GBp pence quotes into GBP
//     (÷100) so every metric feeds the formatter in the portfolio's
//     base unit — never a raw pence integer.
//   - `allocateRoundedShares` splits an authoritative total across
//     N rows using largest-remainder, guaranteeing Σ(rounded rows)
//     === rounded total. Prevents "£301.89 total vs rows summing to
//     £301.88" display drift.

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

/**
 * Round a number to the same 2dp halfExpand grid the formatter uses,
 * but return a `number` (not a string). Use this whenever you need
 * to compare, sum, or scale money values that will later be rendered:
 * doing the arithmetic on the same grid as the display guarantees the
 * two never disagree by ±0.01.
 */
export function roundMoney(
  value: number | null | undefined,
  fractionDigits = 2,
): number {
  if (value == null || !Number.isFinite(value)) return 0;
  const d = Math.max(0, Math.min(6, Math.trunc(fractionDigits)));
  const scale = 10 ** d;
  // halfExpand: round away from zero on the exact half.
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const rounded = Math.round(abs * scale + Number.EPSILON) / scale;
  const out = sign * rounded;
  // Coerce -0 → 0.
  return out === 0 ? 0 : out;
}

/**
 * Convert a native-quote value into the portfolio's base currency where
 * the two only differ by pence-vs-pound scaling. GBX / GBp are the LSE
 * convention for pence: 55.4p == £0.554. All other currency pairs need
 * a real FX rate and are returned unchanged (the caller is responsible
 * for feeding a base-currency amount).
 */
export function normalizeGbxToBase(
  value: number,
  instrumentCcy: string | null | undefined,
  baseCcy: string,
): number {
  if (!Number.isFinite(value)) return 0;
  const inst = String(instrumentCcy ?? "").toUpperCase();
  const base = String(baseCcy ?? "").toUpperCase();
  if ((inst === "GBX" || inst === "GBP.PENCE" || inst === "GBP.PENCE".toUpperCase() || inst === "GBp".toUpperCase()) && base === "GBP") {
    return value / 100;
  }
  return value;
}

/**
 * Largest-remainder allocation. Given raw non-negative shares and an
 * authoritative total (already rounded to the display grid), return
 * an array of 2dp values whose sum is bit-exactly `total`.
 *
 * This is the fix for the classic "rows sum to £301.88 but the tile
 * says £301.89" display bug: naïvely rounding each row independently
 * lets the ±0.005 residues drift.
 */
export function allocateRoundedShares(
  rawShares: readonly number[],
  total: number,
  fractionDigits = 2,
): number[] {
  const n = rawShares.length;
  if (n === 0) return [];
  const d = Math.max(0, Math.min(6, Math.trunc(fractionDigits)));
  const unit = 1 / 10 ** d;
  const totalRounded = roundMoney(total, d);
  const rawSum = rawShares.reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  if (rawSum <= 0 || totalRounded === 0) return rawShares.map(() => 0);

  // Scale each raw share to the target total, then split into
  // an integer number of `unit`s + a remainder for largest-remainder.
  const scale = totalRounded / rawSum;
  const totalUnits = Math.round(totalRounded / unit);
  const scaled = rawShares.map((v) => (Number.isFinite(v) && v > 0 ? v : 0) * scale);
  const floors = scaled.map((v) => Math.floor(v / unit));
  const remainders = scaled.map((v, i) => v / unit - floors[i]);

  let allocatedUnits = floors.reduce((s, v) => s + v, 0);
  let leftover = totalUnits - allocatedUnits;
  // Distribute the leftover units to the rows with the largest fractional
  // remainders (ties broken by original index for determinism).
  const order = remainders
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r - a.r) || (a.i - b.i));
  const out = floors.slice();
  for (const { i } of order) {
    if (leftover <= 0) break;
    out[i] += 1;
    leftover -= 1;
  }
  // Guard for negative leftover (shouldn't happen for positive inputs).
  if (leftover < 0) {
    const desc = remainders
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (a.r - b.r) || (a.i - b.i));
    for (const { i } of desc) {
      if (leftover >= 0) break;
      if (out[i] > 0) {
        out[i] -= 1;
        leftover += 1;
      }
    }
  }
  return out.map((u) => roundMoney(u * unit, d));
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

/**
 * Signed variant used on delta lines: prefixes an explicit "+" for
 * positive values and a Unicode minus for negative values so gains
 * and losses can never be confused with a hyphen.
 */
export function formatMoneySigned(
  value: number | null | undefined,
  currency: string = "GBP",
  fractionDigits?: number,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "\u2212" : "";
  const body = formatMoneyAmount(Math.abs(value), fractionDigits);
  return body === "—" ? "—" : `${sign}${currency} ${body}`;
}
