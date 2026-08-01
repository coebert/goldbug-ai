// Bulk auto-correction for mis-tagged `instrument_ccy` values.
//
// Pure planner. It converts the findings from `instrument-ccy-check` into a
// concrete list of row updates, and — just as importantly — refuses to touch
// the rows where the right answer is not obvious. Only a symbol that carries
// real venue information (MIC, exchange suffix, FX/crypto pair, or a known US
// root) can be corrected automatically; anything else is left for a human.

import type { InstrumentCcyFinding } from "./instrument-ccy-check";
import { venueCurrency } from "./instrument-ccy-rules";

/** Sources we trust to decide a currency without a human in the loop. */
const CONFIDENT_SOURCES = new Set(["mic", "suffix", "pair", "known_root"]);

/** Issue codes that a currency re-tag actually fixes. */
const FIXABLE = new Set([
  "venue_mismatch",
  "fx_conversion_skipped",
  "quote_unit_as_currency",
  "missing_currency",
]);

export type InstrumentCcyFixPlanItem = {
  symbol: string;
  from_ccy: string | null;
  to_ccy: string;
  /** Which rule decided the currency (mic / suffix / pair / known_root). */
  source: string;
  reason: string;
  /** Base-currency value the position takes once the FX leg is applied. */
  value_base: number | null;
  /** Value the mis-tagged row was producing, when it could be computed. */
  value_base_declared: number | null;
};

export type InstrumentCcyFixSkip = {
  symbol: string;
  reason: string;
};

export type InstrumentCcyFixPlan = {
  fixes: InstrumentCcyFixPlanItem[];
  skipped: InstrumentCcyFixSkip[];
  summary: string;
};

/**
 * Decide which flagged holdings can be re-tagged automatically.
 *
 * A finding is auto-correctable when all of these hold:
 *  - at least one of its issues is a currency-tagging issue (not purely a
 *    divisor or snapshot-magnitude problem, which re-tagging cannot fix),
 *  - the symbol itself implies a currency through a trusted rule, and
 *  - that currency differs from what the row stores.
 *
 * A `divisor_mismatch` makes the row ambiguous — the feed and the ledger
 * disagree about pence vs pounds, so changing the currency could entrench the
 * wrong reading. Those are always skipped.
 */
export function planInstrumentCcyFixes(findings: InstrumentCcyFinding[]): InstrumentCcyFixPlan {
  const fixes: InstrumentCcyFixPlanItem[] = [];
  const skipped: InstrumentCcyFixSkip[] = [];

  for (const finding of findings) {
    const codes = new Set(finding.issues.map((i) => i.code));
    const symbol = String(finding.symbol ?? "").trim();
    if (!symbol) continue;

    if (codes.has("divisor_mismatch")) {
      skipped.push({
        symbol,
        reason:
          "Quote and average cost disagree by ~100x, so the pence/pound reading is ambiguous — re-tagging the currency could lock in the wrong one.",
      });
      continue;
    }

    if (![...codes].some((c) => FIXABLE.has(c))) {
      skipped.push({
        symbol,
        reason: "Flagged for a price-unit issue that changing the currency tag would not fix.",
      });
      continue;
    }

    const venue = venueCurrency(symbol);
    if (!venue || !CONFIDENT_SOURCES.has(venue.source)) {
      skipped.push({
        symbol,
        reason: `No venue marker on ${symbol} (no MIC, exchange suffix or pair), so the correct currency cannot be inferred with confidence.`,
      });
      continue;
    }

    if (finding.declared_ccy === venue.currency) {
      skipped.push({ symbol, reason: `Already tagged ${venue.currency}.` });
      continue;
    }

    const from = finding.declared_ccy;
    fixes.push({
      symbol,
      from_ccy: from,
      to_ccy: venue.currency,
      source: venue.source,
      reason: from
        ? `${symbol} lists in ${venue.currency} (by ${venue.source}); stored as ${from}, which ${
            codes.has("fx_conversion_skipped")
              ? "skipped the FX conversion entirely"
              : "sent valuation down a different FX path"
          }.`
        : `${symbol} lists in ${venue.currency} (by ${venue.source}); the row had no currency tag.`,
      value_base: finding.value_base,
      value_base_declared: finding.value_base_declared,
    });
  }

  const summary =
    fixes.length === 0
      ? skipped.length
        ? `No holding can be re-tagged automatically; ${skipped.length} need a manual decision.`
        : "Nothing to correct."
      : `${fixes.length} holding${fixes.length === 1 ? "" : "s"} can be re-tagged automatically${
          skipped.length ? `; ${skipped.length} need a manual decision` : ""
        }.`;

  return { fixes, skipped, summary };
}
