// Automated consistency check for a holding's stored `instrument_ccy`.
//
// Three independent facts should agree about how a position is priced:
//
//   1. the listing venue implied by the symbol (`JNJ:xnys` → USD, `ISF.L` → GBP)
//   2. the `instrument_ccy` stored on the holdings row
//   3. the magnitude of the recent feed quotes versus the position's own
//      average cost and the most recent stored snapshot
//
// When they disagree, one of the valuation paths silently skips an FX
// conversion (a USD leg tagged GBP is never converted) or applies the wrong
// divisor (a pence quote treated as pounds is 100x too high). Both produce a
// tile that reads plausibly but is wrong by a fixed factor, which is exactly
// the class of bug this module surfaces before a human notices it.
//
// Pure: no I/O, no clock. The server driver supplies quotes, FX and snapshot.

import { instrumentCurrency, type RevalueHolding } from "./equity-snapshot-revalue";
import { isLseGbxDisplayQuoted } from "./market-price-units";

export type InstrumentCcyIssueCode =
  /** Stored currency differs from the currency implied by the listing venue. */
  | "venue_mismatch"
  /** Stored currency equals the base currency, so FX is skipped entirely. */
  | "fx_conversion_skipped"
  /** Row carries GBX/GBp — a quote unit, not a settlement currency. */
  | "quote_unit_as_currency"
  /** No currency stored at all; every path falls back to a guess. */
  | "missing_currency"
  /** Recent close vs average cost differ by ~100x — a divisor disagreement. */
  | "divisor_mismatch"
  /** The stored snapshot only reconciles under a different currency/divisor. */
  | "snapshot_implies_other_unit";

export type Severity = "high" | "medium" | "low";

export type InstrumentCcyIssue = {
  code: InstrumentCcyIssueCode;
  severity: Severity;
  message: string;
};

export type InstrumentCcyFinding = {
  symbol: string;
  quantity: number;
  /** Currency as stored on the holdings row (raw, uppercased). */
  declared_ccy: string | null;
  /** Currency implied by the listing venue — what valuation actually uses. */
  venue_ccy: string;
  /** True when the feed quotes this symbol in pence and valuation folds ÷100. */
  pence_quoted: boolean;
  expected_divisor: 1 | 100;
  /** Divisor the recent quote magnitude implies, when it can be inferred. */
  implied_divisor: 1 | 100 | null;
  recent_quote: number | null;
  recent_quote_date: string | null;
  avg_cost: number | null;
  /** recent_quote ÷ avg_cost after the expected fold; ~100 or ~0.01 is a bug. */
  quote_cost_ratio: number | null;
  /** Position value in base under the currency valuation will actually use. */
  value_base: number | null;
  /** Value in base if the declared currency were honoured instead. */
  value_base_declared: number | null;
  issues: InstrumentCcyIssue[];
  severity: Severity | null;
};

export type InstrumentCcyCheckReport = {
  portfolio_id: string;
  base_ccy: string;
  checked: number;
  /** Only the holdings with at least one issue, worst first. */
  findings: InstrumentCcyFinding[];
  /** Snapshot the magnitude cross-check was run against, when available. */
  snapshot: { date: string; holdings_value: number } | null;
  /** computed ÷ stored holdings value; ~100 / ~0.01 means a unit bug. */
  snapshot_ratio: number | null;
  summary: string;
};

/** A ratio counts as a 100x unit error inside this band. */
const HUNDRED_LO = 40;
const HUNDRED_HI = 250;

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

function num(value: number | string | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, dp = 6): number {
  const scale = 10 ** dp;
  return Math.round(value * scale) / scale;
}

function isHundredX(ratio: number): boolean {
  return ratio >= HUNDRED_LO && ratio <= HUNDRED_HI;
}

function worst(issues: InstrumentCcyIssue[]): Severity | null {
  let out: Severity | null = null;
  for (const i of issues) {
    if (!out || SEVERITY_RANK[i.severity] > SEVERITY_RANK[out]) out = i.severity;
  }
  return out;
}

export type RecentQuote = { close: number; date: string };

export function checkInstrumentCurrencies({
  portfolioId,
  baseCcy,
  holdings,
  quotes = new Map<string, RecentQuote>(),
  fx = new Map<string, number>(),
  snapshot = null,
}: {
  portfolioId: string;
  baseCcy: string;
  holdings: RevalueHolding[];
  /** Most recent usable close per holding symbol (as stored on the row). */
  quotes?: Map<string, RecentQuote>;
  /** instrument ccy → base rate. Missing entries are treated as unknown. */
  fx?: Map<string, number>;
  snapshot?: { date: string; holdings_value: number | string | null } | null;
}): InstrumentCcyCheckReport {
  const base = String(baseCcy ?? "GBP").toUpperCase();
  const findings: InstrumentCcyFinding[] = [];
  let computedValue = 0;
  let checked = 0;

  for (const holding of holdings) {
    const symbol = String(holding.symbol ?? "").trim();
    if (!symbol) continue;
    const quantity = num(holding.quantity) ?? 0;
    if (!(quantity > 0)) continue;
    checked += 1;

    const declaredRaw = String(holding.instrument_ccy ?? "").trim();
    const declared = declaredRaw ? declaredRaw.toUpperCase() : null;
    const venue = instrumentCurrency(holding).toUpperCase();
    const pence = isLseGbxDisplayQuoted(symbol);
    const expectedDivisor: 1 | 100 = pence ? 100 : 1;

    const quote = quotes.get(symbol) ?? null;
    const avgCost = num(holding.avg_cost);
    const raw = quote?.close ?? null;
    const folded = raw != null ? raw / expectedDivisor : null;

    const rate = fx.get(venue);
    const usableRate = venue === base ? 1 : Number.isFinite(rate) && (rate ?? 0) > 0 ? rate! : null;
    const declaredRate =
      declared == null
        ? null
        : declared === base
          ? 1
          : Number.isFinite(fx.get(declared)) && (fx.get(declared) ?? 0) > 0
            ? fx.get(declared)!
            : null;

    const valueBase = folded != null && usableRate != null ? quantity * folded * usableRate : null;
    const valueBaseDeclared =
      folded != null && declaredRate != null ? quantity * folded * declaredRate : null;
    if (valueBase != null) computedValue += valueBase;

    const issues: InstrumentCcyIssue[] = [];

    if (!declared) {
      issues.push({
        code: "missing_currency",
        severity: "medium",
        message: `No instrument_ccy stored; valuation falls back to the venue currency (${venue}).`,
      });
    } else if (declared === "GBX" || declaredRaw === "GBp") {
      issues.push({
        code: "quote_unit_as_currency",
        severity: "medium",
        message:
          "instrument_ccy is a quote unit (GBX/GBp), not a settlement currency. Store GBP and let the ÷100 fold handle pence.",
      });
    } else if (declared !== venue) {
      issues.push({
        code: "venue_mismatch",
        severity: "medium",
        message: `Stored as ${declared} but the listing venue implies ${venue}; valuation paths that trust the row disagree with the ones that trust the symbol.`,
      });
      if (declared === base && venue !== base) {
        issues.push({
          code: "fx_conversion_skipped",
          severity: "high",
          message: `${declared} is the portfolio's base currency, so any path reading the row skips the ${venue}→${base} conversion entirely.`,
        });
      }
    }

    // Magnitude cross-check: after the expected fold a close should be within a
    // sane multiple of the position's own average cost. A ~100x gap means the
    // feed and the ledger disagree about pence vs pounds for this symbol.
    let impliedDivisor: 1 | 100 | null = null;
    let quoteCostRatio: number | null = null;
    if (folded != null && avgCost != null && avgCost > 0 && folded > 0) {
      quoteCostRatio = round(folded / avgCost, 6);
      if (isHundredX(quoteCostRatio)) {
        impliedDivisor = expectedDivisor === 1 ? 100 : 1;
        issues.push({
          code: "divisor_mismatch",
          severity: "high",
          message: `Recent close folds to ${round(folded, 4)} but average cost is ${round(avgCost, 4)} (~${Math.round(quoteCostRatio)}x). The feed looks ${expectedDivisor === 1 ? "pence-quoted while the row is treated as pounds" : "pound-quoted while a ÷100 fold is applied"}.`,
        });
      } else if (isHundredX(1 / quoteCostRatio)) {
        impliedDivisor = expectedDivisor === 100 ? 1 : 100;
        issues.push({
          code: "divisor_mismatch",
          severity: "high",
          message: `Recent close folds to ${round(folded, 4)} but average cost is ${round(avgCost, 4)} (~${Math.round(1 / quoteCostRatio)}x the other way). The ÷${expectedDivisor} fold applied to this symbol looks wrong.`,
        });
      } else {
        impliedDivisor = expectedDivisor;
      }
    }

    findings.push({
      symbol,
      quantity: round(quantity, 8),
      declared_ccy: declared,
      venue_ccy: venue,
      pence_quoted: pence,
      expected_divisor: expectedDivisor,
      implied_divisor: impliedDivisor,
      recent_quote: raw != null ? round(raw, 6) : null,
      recent_quote_date: quote?.date ?? null,
      avg_cost: avgCost,
      quote_cost_ratio: quoteCostRatio,
      value_base: valueBase != null ? round(valueBase, 2) : null,
      value_base_declared: valueBaseDeclared != null ? round(valueBaseDeclared, 2) : null,
      issues,
      severity: worst(issues),
    });
  }

  // Snapshot cross-check: if the stored holdings value only reconciles at ~100x
  // or ~1/100 of what the declared units produce, the stored row and the tiles
  // are computed under different unit assumptions.
  const storedValue = snapshot ? num(snapshot.holdings_value) : null;
  let snapshotRatio: number | null = null;
  if (storedValue != null && storedValue > 0 && computedValue > 0) {
    snapshotRatio = round(computedValue / storedValue, 6);
    if (isHundredX(snapshotRatio) || isHundredX(1 / snapshotRatio)) {
      const target = findings.length ? findings : [];
      const message = `Holdings value computed from current units is ${round(snapshotRatio, 4)}x the value stored for ${snapshot?.date}. One of the two used a different price-unit source.`;
      // Attribute to the largest position, which dominates any such ratio.
      const culprit = target
        .slice()
        .sort((a, b) => (b.value_base ?? 0) - (a.value_base ?? 0))[0];
      if (culprit) {
        culprit.issues.push({
          code: "snapshot_implies_other_unit",
          severity: "high",
          message,
        });
        culprit.severity = worst(culprit.issues);
      }
    }
  }

  const flagged = findings
    .filter((f) => f.issues.length > 0)
    .sort((a, b) => {
      const rank = SEVERITY_RANK[b.severity ?? "low"] - SEVERITY_RANK[a.severity ?? "low"];
      if (rank !== 0) return rank;
      return (b.value_base ?? 0) - (a.value_base ?? 0);
    });

  const highs = flagged.filter((f) => f.severity === "high").length;
  const summary =
    flagged.length === 0
      ? `All ${checked} holdings agree on currency and price units.`
      : `${flagged.length} of ${checked} holdings have a currency or price-unit inconsistency${highs ? ` (${highs} high severity)` : ""}.`;

  return {
    portfolio_id: portfolioId,
    base_ccy: base,
    checked,
    findings: flagged,
    snapshot:
      snapshot && storedValue != null
        ? { date: snapshot.date, holdings_value: round(storedValue, 2) }
        : null,
    snapshot_ratio: snapshotRatio,
    summary,
  };
}
