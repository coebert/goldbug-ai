// Valuation consistency check.
//
// A portfolio tile can only move so far in one day. A 3x jump between
// consecutive daily snapshots is not a market move — it is almost always a
// price-unit fault: a GBX quote that skipped the ÷100 fold (~100x), a pound
// quote folded anyway (~0.01x), or a foreign leg that lost its FX rate
// (typically 1.1x–1.6x, which shows up as a jump only on concentrated books).
//
// This module is pure. It takes the stored snapshot series plus (optionally)
// the price-unit audit for the suspect day, and reports which day broke, how
// badly, and which quote is the likely culprit.

import type { FxSource, PriceUnitAudit, PriceUnitAuditRow } from "./price-unit-audit";

/** Default implausibility threshold: more than a 3x move in one step. */
export const DEFAULT_JUMP_FACTOR = 3;

export type ConsistencySnapshot = {
  snapshot_date: string;
  total_value: number | string | null;
  holdings_value?: number | string | null;
  cash?: number | string | null;
};

export type SuspectedUnitSource =
  /** Ratio near 100x/0.01x — a pence quote that was (or wasn't) folded. */
  | "gbx_pence_fold"
  /** A leg is missing its instrument→base rate. */
  | "missing_fx_rate"
  /** The day's value leans on average cost or a stale carried quote. */
  | "stale_or_missing_quote"
  /** Cash, not marks, moved — a deposit/withdrawal, not a unit bug. */
  | "cash_movement"
  | "unknown";

export type ValuationJump = {
  date: string;
  previous_date: string;
  previous_value: number;
  value: number;
  /** value ÷ previous_value. >3 or <1/3 by default. */
  ratio: number;
  direction: "up" | "down";
  /** How much of the change came from cash rather than marks. */
  cash_delta: number;
  holdings_ratio: number | null;
  suspected_source: SuspectedUnitSource;
  /** Symbols whose own arithmetic explains the jump, worst first. */
  suspect_symbols: {
    symbol: string;
    reason: string;
    quote_currency: string;
    raw_quote: number;
    price_in_instrument_ccy: number;
    fx_pair: string;
    fx_rate: number;
    value_base: number;
    weight: number;
    /** FX conversion detail for this symbol on this day. */
    fx: SymbolFxConversion;
  }[];
  /** Per-currency FX legs used to value the flagged day, largest first. */
  fx_breakdown: FxLeg[];
  /**
   * True when an external cash flow (deposit/withdrawal) fully explains the
   * move. Those days are reported for the audit trail but are NOT faults, so
   * the UI must not surface them as errors.
   */
  benign: boolean;
  explanation: string;
};

/** How one symbol's instrument-currency value became a base-currency value. */
export type SymbolFxConversion = {
  /** Currency the instrument is priced in after any pence fold. */
  from_ccy: string;
  /** Portfolio base currency. */
  to_ccy: string;
  pair: string;
  rate: number;
  source: FxSource;
  /** True when no rate existed and 1.0 was assumed. */
  assumed: boolean;
  value_from: number;
  value_to: number;
  /** e.g. "1,250.00 USD × 0.7840 USD/GBP = 980.00 GBP". */
  detail: string;
};

/** One source-currency leg of the flagged day's valuation. */
export type FxLeg = {
  from_ccy: string;
  to_ccy: string;
  pair: string;
  rate: number;
  source: FxSource;
  assumed: boolean;
  positions: number;
  value_from: number;
  value_to: number;
  /** Share of the day's marked book carried by this currency (0–1). */
  weight: number;
};


/**
 * A stretch of the series with no stored snapshot. A gap is invisible to the
 * jump check — the two rows either side can sit a fortnight apart and still
 * differ by 1%, so the ratio test passes while the chart draws a straight
 * line across missing history.
 */
export type SnapshotGap = {
  /** Last day that has a snapshot before the hole. */
  from: string;
  /** First day that has a snapshot after the hole (or today, when trailing). */
  to: string;
  /** Calendar days between the two, inclusive of neither endpoint. */
  missing_days: number;
  /** Of those, how many are weekdays — the days a venue could have marked. */
  missing_weekdays: number;
  /** "interior" sits between two stored rows; "trailing" runs up to today. */
  kind: "interior" | "trailing";
  /** Value either side, so the UI can show what the straight line spans. */
  value_from: number;
  value_to: number | null;
  explanation: string;
};

export type ValuationConsistencyReport = {
  portfolio_id: string;
  base_ccy: string;
  daysChecked: number;
  threshold: number;
  jumps: ValuationJump[];
  /** Largest-ratio jump, or null when the series looks sane. */
  worst: ValuationJump | null;
  /** Missing stretches of history, longest first. */
  gaps: SnapshotGap[];
  /** Weekday gap size that trips the continuity check. */
  gapThreshold: number;
};


function num(value: number | string | null | undefined, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number, dp = 4): number {
  const scale = 10 ** dp;
  return Math.round(value * scale) / scale;
}

function nearlyHundredFold(ratio: number): boolean {
  return (ratio >= 50 && ratio <= 200) || (ratio >= 1 / 200 && ratio <= 1 / 50);
}

/** Rank audit rows by how likely each is to be the cause of a jump. */
export function suspectRowsFor(
  audit: PriceUnitAudit | null | undefined,
  ratio: number,
): { rows: PriceUnitAuditRow[]; source: SuspectedUnitSource } {
  if (!audit || audit.rows.length === 0) {
    return { rows: [], source: nearlyHundredFold(ratio) ? "gbx_pence_fold" : "unknown" };
  }

  const pence = audit.rows.filter((r) => r.pence_folded || r.quote_currency === "GBX");
  const missingFx = audit.rows.filter((r) => r.fx_source === "assumed_identity");
  const stale = audit.rows.filter(
    (r) => r.price_source === "avg_cost" || r.price_source === "missing",
  );

  const byWeight = (a: PriceUnitAuditRow, b: PriceUnitAuditRow) => b.weight - a.weight;

  if (nearlyHundredFold(ratio) && pence.length > 0) {
    return { rows: [...pence].sort(byWeight), source: "gbx_pence_fold" };
  }
  if (missingFx.length > 0) {
    return { rows: [...missingFx].sort(byWeight), source: "missing_fx_rate" };
  }
  if (pence.length > 0 && nearlyHundredFold(ratio)) {
    return { rows: [...pence].sort(byWeight), source: "gbx_pence_fold" };
  }
  if (stale.length > 0) {
    return { rows: [...stale].sort(byWeight), source: "stale_or_missing_quote" };
  }
  if (pence.length > 0) {
    return { rows: [...pence].sort(byWeight), source: "gbx_pence_fold" };
  }
  return { rows: [], source: "unknown" };
}

function money(value: number, ccy: string): string {
  return `${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;
}

function rateText(rate: number): string {
  return rate.toLocaleString("en-GB", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

/** Spell out the instrument→base conversion applied to one audit row. */
export function fxConversionFor(row: PriceUnitAuditRow, baseCcy: string): SymbolFxConversion {
  const from = (row.instrument_ccy || baseCcy).toUpperCase();
  const to = baseCcy.toUpperCase();
  const assumed = row.fx_source === "assumed_identity";
  const detail =
    from === to
      ? `${money(row.value_instrument_ccy, from)} — already in base currency, no conversion`
      : `${money(row.value_instrument_ccy, from)} × ${rateText(row.fx_rate)} ${row.fx_pair}` +
        ` = ${money(row.value_base, to)}${assumed ? " (no rate found — 1.0 assumed)" : ""}`;

  return {
    from_ccy: from,
    to_ccy: to,
    pair: row.fx_pair || `${from}/${to}`,
    rate: row.fx_rate,
    source: row.fx_source,
    assumed,
    value_from: row.value_instrument_ccy,
    value_to: row.value_base,
    detail,
  };
}

/** Per-source-currency FX legs behind a flagged day's valuation, largest first. */
export function fxBreakdownFor(
  audit: PriceUnitAudit | null | undefined,
  baseCcy: string,
): FxLeg[] {
  if (!audit || audit.rows.length === 0) return [];
  const to = baseCcy.toUpperCase();

  const legs = new Map<string, FxLeg>();
  for (const row of audit.rows) {
    const from = (row.instrument_ccy || to).toUpperCase();
    const existing = legs.get(from);
    if (existing) {
      existing.positions += 1;
      existing.value_from = round(existing.value_from + row.value_instrument_ccy, 2);
      existing.value_to = round(existing.value_to + row.value_base, 2);
      existing.assumed = existing.assumed || row.fx_source === "assumed_identity";
      if (row.fx_source === "assumed_identity") existing.source = "assumed_identity";
      continue;
    }
    legs.set(from, {
      from_ccy: from,
      to_ccy: to,
      pair: row.fx_pair || `${from}/${to}`,
      rate: row.fx_rate,
      source: row.fx_source,
      assumed: row.fx_source === "assumed_identity",
      positions: 1,
      value_from: round(row.value_instrument_ccy, 2),
      value_to: round(row.value_base, 2),
      weight: 0,
    });
  }

  const total = [...legs.values()].reduce((sum, leg) => sum + Math.abs(leg.value_to), 0);
  return [...legs.values()]
    .map((leg) => ({ ...leg, weight: total > 0 ? round(Math.abs(leg.value_to) / total, 4) : 0 }))
    .sort((a, b) => Math.abs(b.value_to) - Math.abs(a.value_to));
}

function reasonFor(row: PriceUnitAuditRow): string {

  if (row.fx_source === "assumed_identity") {
    return `No ${row.fx_pair} rate — converted at 1.0`;
  }
  if (row.price_source === "missing") return "No quote at all — valued at zero";
  if (row.price_source === "avg_cost") return "Valued at average cost, not a market close";
  if (row.pence_folded) {
    return `Pence quote ${row.raw_quote} GBX folded ÷100 → ${row.price_in_instrument_ccy} ${row.instrument_ccy}`;
  }
  return `${row.instrument_ccy} quote used without a unit fold`;
}

const SOURCE_TEXT: Record<SuspectedUnitSource, string> = {
  gbx_pence_fold: "a pence (GBX) quote being folded to pounds inconsistently",
  missing_fx_rate: "a missing instrument→base FX rate",
  stale_or_missing_quote: "a stale or missing market quote",
  cash_movement: "a cash deposit or withdrawal, not a pricing fault",
  unknown: "an unidentified pricing step",
};

export function checkValuationConsistency({
  portfolioId,
  snapshots,
  audits = {},
  baseCcy = "GBP",
  jumpFactor = DEFAULT_JUMP_FACTOR,
}: {
  portfolioId: string;
  snapshots: ConsistencySnapshot[];
  /** Price-unit audit keyed by snapshot date, where one was built. */
  audits?: Record<string, PriceUnitAudit | null | undefined>;
  baseCcy?: string;
  jumpFactor?: number;
}): ValuationConsistencyReport {
  const threshold = Math.max(1.0001, jumpFactor);
  const ordered = [...snapshots]
    .map((s) => ({
      date: String(s.snapshot_date).slice(0, 10),
      total: num(s.total_value),
      holdings: s.holdings_value == null ? null : num(s.holdings_value),
      cash: num(s.cash),
    }))
    .filter((s) => s.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const jumps: ValuationJump[] = [];

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    // A zero/negative prior value has no meaningful ratio; funding a fresh
    // portfolio is not a jump.
    if (prev.total <= 0 || curr.total <= 0) continue;

    const ratio = curr.total / prev.total;
    if (ratio < threshold && ratio > 1 / threshold) continue;

    const cashDelta = round(curr.cash - prev.cash, 2);
    const holdingsRatio =
      prev.holdings != null && curr.holdings != null && prev.holdings > 0
        ? round(curr.holdings / prev.holdings, 4)
        : null;

    // External cash explains the move: not a unit fault.
    const explainedByCash =
      Math.abs(cashDelta) > 0 &&
      Math.abs(curr.total - prev.total - cashDelta) <= Math.abs(curr.total - prev.total) * 0.05;

    const audit = audits[curr.date] ?? null;
    const { rows, source } = explainedByCash
      ? { rows: [] as PriceUnitAuditRow[], source: "cash_movement" as SuspectedUnitSource }
      : suspectRowsFor(audit, holdingsRatio ?? ratio);

    const suspects = rows.slice(0, 5).map((r) => ({
      symbol: r.symbol,
      reason: reasonFor(r),
      quote_currency: r.quote_currency,
      raw_quote: r.raw_quote,
      price_in_instrument_ccy: r.price_in_instrument_ccy,
      fx_pair: r.fx_pair,
      fx_rate: r.fx_rate,
      value_base: r.value_base,
      weight: r.weight,
      fx: fxConversionFor(r, baseCcy.toUpperCase()),
    }));

    const fxBreakdown = explainedByCash ? [] : fxBreakdownFor(audit, baseCcy.toUpperCase());


    const direction: "up" | "down" = ratio >= 1 ? "up" : "down";
    const shown = round(ratio, 2);
    const explanation =
      `Total value moved ${direction === "up" ? "up" : "down"} ${shown}x between ${prev.date} and ${curr.date} ` +
      `(${round(prev.total, 2)} → ${round(curr.total, 2)} ${baseCcy.toUpperCase()}). ` +
      `Most likely cause: ${SOURCE_TEXT[source]}` +
      (suspects.length > 0 ? ` — check ${suspects.map((s) => s.symbol).join(", ")}.` : ".");

    jumps.push({
      date: curr.date,
      previous_date: prev.date,
      previous_value: round(prev.total, 2),
      value: round(curr.total, 2),
      ratio: round(ratio, 4),
      direction,
      cash_delta: cashDelta,
      holdings_ratio: holdingsRatio,
      suspected_source: source,
      suspect_symbols: suspects,
      fx_breakdown: fxBreakdown,
      benign: explainedByCash,
      explanation,
    });
  }

  const scored = [...jumps]
    .filter((j) => !j.benign)
    .sort(
      (a, b) => Math.max(b.ratio, 1 / b.ratio) - Math.max(a.ratio, 1 / a.ratio),
    );

  return {
    portfolio_id: portfolioId,
    base_ccy: baseCcy.toUpperCase(),
    daysChecked: Math.max(0, ordered.length - 1),
    threshold,
    jumps,
    worst: scored[0] ?? null,
  };
}
