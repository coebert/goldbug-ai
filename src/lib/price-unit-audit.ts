// Full audit trail for how a holding's value was computed on a given day.
//
// Every valuation surface in the app runs the same three-step pipeline:
//
//   raw feed quote  →  fold pence to pounds  →  apply instrument→base FX
//
// When a tile looks wrong the question is always *which* step misfired: a
// GBX quote that was never folded (100x too high), a pound quote that was
// folded anyway (100x too low), or a USD leg that never got an FX rate
// (~15% too high in a EUR portfolio). This module replays the pipeline and
// records each step, its inputs, and its output, so the arithmetic can be
// read straight off the screen instead of inferred from a total.
//
// Pure: no I/O, no clock. The server driver supplies prices and FX.

import {
  instrumentCurrency,
  positionsOn,
  symbolKeys,
  type RevalueFill,
  type RevalueHolding,
} from "./equity-snapshot-revalue";
import { isLseGbxDisplayQuoted } from "./market-price-units";

export type PriceSource =
  /** A close stored for exactly the audited day. */
  | "close"
  /** The most recent earlier close, carried forward (market closed / gap). */
  | "carried_close"
  /** No close at all — the position's average cost stood in. */
  | "avg_cost"
  /** Neither a close nor a usable cost: the leg contributes nothing. */
  | "missing";

export type FxSource =
  /** Instrument already quotes in the portfolio's base currency. */
  | "identity"
  /** A real rate was supplied for this pair. */
  | "rate"
  /** No rate available — 1.0 assumed, and the row is flagged. */
  | "assumed_identity";

export type AuditStep = {
  label: string;
  detail: string;
  /** Running value after this step, in the step's own units. */
  value: number;
  unit: string;
};

export type PriceUnitAuditRow = {
  symbol: string;
  /** The `price_cache` spelling the quote was actually read from. */
  price_key: string | null;
  quantity: number;

  raw_quote: number;
  /** Day the quote is from — earlier than `date` when carried forward. */
  quote_date: string | null;
  price_source: PriceSource;
  /** What the feed quotes this symbol in, before any folding. */
  quote_currency: string;

  /** True when the raw quote was pence and was divided by 100. */
  pence_folded: boolean;
  divisor: 1 | 100;
  /** Price after folding, in the instrument's settlement currency. */
  price_in_instrument_ccy: number;
  instrument_ccy: string;

  fx_rate: number;
  fx_source: FxSource;
  fx_pair: string;

  value_instrument_ccy: number;
  value_base: number;
  base_ccy: string;

  /** Share of the day's holdings value, 0–1. */
  weight: number;
  /** Human-readable replay of the three pipeline steps. */
  steps: AuditStep[];
  warnings: string[];
};

export type PriceUnitAudit = {
  portfolio_id: string;
  date: string;
  base_ccy: string;
  rows: PriceUnitAuditRow[];
  /** Sum of `value_base` across rows. */
  holdings_value: number;
  cash: number;
  total_value: number;
  /** Value contributed per settlement currency, in base terms. */
  by_currency: { currency: string; value_base: number; fx_rate: number; positions: number }[];
  /** Stored snapshot for the day, when one exists. */
  stored: { holdings_value: number; total_value: number } | null;
  /** computed ÷ stored — ~100 or ~0.01 means a unit bug, not drift. */
  stored_ratio: number | null;
  warnings: string[];
};

function num(value: number | string | null | undefined, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number, dp = 6): number {
  const scale = 10 ** dp;
  return Math.round(value * scale) / scale;
}

/** Resolve the day's quote *and* say where it came from. */
export function resolveQuote(
  prices: Map<string, Map<string, number>>,
  symbol: string,
  date: string,
): { key: string; close: number; date: string } | null {
  for (const key of symbolKeys(symbol)) {
    const series = prices.get(key);
    if (!series) continue;
    let best: { close: number; date: string } | null = null;
    for (const [d, close] of series) {
      if (d > date || !Number.isFinite(close) || close <= 0) continue;
      if (!best || d >= best.date) best = { close, date: d };
    }
    if (best) return { key, close: best.close, date: best.date };
  }
  return null;
}

export function auditPriceUnits({
  portfolioId,
  date,
  baseCcy,
  holdings,
  fills = [],
  prices,
  fx = new Map<string, number>(),
  cash = 0,
  stored = null,
}: {
  portfolioId: string;
  date: string;
  baseCcy: string;
  holdings: RevalueHolding[];
  fills?: RevalueFill[];
  prices: Map<string, Map<string, number>>;
  fx?: Map<string, number>;
  cash?: number;
  stored?: { holdings_value?: number | string | null; total_value?: number | string | null } | null;
}): PriceUnitAudit {
  const base = String(baseCcy ?? "GBP").toUpperCase();
  const book = positionsOn(holdings, fills, date);
  const rows: PriceUnitAuditRow[] = [];

  for (const { quantity, holding } of book.values()) {
    const symbol = String(holding.symbol ?? "");
    const quote = resolveQuote(prices, symbol, date);
    const avgCost = num(holding.avg_cost);

    let raw = 0;
    let priceSource: PriceSource = "missing";
    if (quote) {
      raw = quote.close;
      priceSource = quote.date === date ? "close" : "carried_close";
    } else if (avgCost > 0) {
      raw = avgCost;
      priceSource = "avg_cost";
    }

    // Step 1 — unit fold. The pence rule is symbol-driven, never asset_class.
    const pence = isLseGbxDisplayQuoted(symbol);
    const divisor: 1 | 100 = pence ? 100 : 1;
    const instrumentCcy = instrumentCurrency(holding).toUpperCase();
    const quoteCurrency = pence ? "GBX" : instrumentCcy;
    const folded = raw / divisor;

    // Step 2 — FX into the portfolio's base currency.
    const supplied = fx.get(instrumentCcy);
    const fxSource: FxSource =
      instrumentCcy === base
        ? "identity"
        : Number.isFinite(supplied) && (supplied ?? 0) > 0
          ? "rate"
          : "assumed_identity";
    const rate = fxSource === "rate" ? (supplied as number) : 1;

    const valueInstrument = quantity * folded;
    const valueBase = valueInstrument * rate;

    const warnings: string[] = [];
    if (priceSource === "missing") {
      warnings.push("No close and no average cost — this leg is valued at zero.");
    } else if (priceSource === "avg_cost") {
      warnings.push("No close on or before this day; average cost used instead.");
    } else if (priceSource === "carried_close" && quote) {
      warnings.push(`Quote carried forward from ${quote.date}.`);
    }
    if (fxSource === "assumed_identity") {
      warnings.push(
        `No ${instrumentCcy}→${base} rate available; 1.0 assumed, so this value is understated or overstated by the true rate.`,
      );
    }

    rows.push({
      symbol,
      price_key: quote?.key ?? null,
      quantity: round(quantity, 8),
      raw_quote: round(raw),
      quote_date: quote?.date ?? null,
      price_source: priceSource,
      quote_currency: quoteCurrency,
      pence_folded: pence,
      divisor,
      price_in_instrument_ccy: round(folded),
      instrument_ccy: instrumentCcy,
      fx_rate: round(rate),
      fx_source: fxSource,
      fx_pair: `${instrumentCcy}/${base}`,
      value_instrument_ccy: round(valueInstrument, 2),
      value_base: round(valueBase, 2),
      base_ccy: base,
      weight: 0,
      steps: [
        {
          label: "Feed quote",
          detail: `${priceSource.replace("_", " ")}${quote ? ` from ${quote.key} on ${quote.date}` : ""}`,
          value: round(raw),
          unit: quoteCurrency,
        },
        {
          label: pence ? "Fold pence → pounds" : "No unit fold",
          detail: pence
            ? `${round(raw)} ${quoteCurrency} ÷ 100`
            : `${instrumentCcy} quote used as-is`,
          value: round(folded),
          unit: instrumentCcy,
        },
        {
          label: "Position value",
          detail: `${round(quantity, 8)} × ${round(folded)}`,
          value: round(valueInstrument, 2),
          unit: instrumentCcy,
        },
        {
          label: fxSource === "identity" ? "Already in base currency" : `Convert ${instrumentCcy}→${base}`,
          detail:
            fxSource === "identity"
              ? "No conversion needed"
              : `${round(valueInstrument, 2)} × ${round(rate)}${fxSource === "assumed_identity" ? " (assumed)" : ""}`,
          value: round(valueBase, 2),
          unit: base,
        },
      ],
      warnings,
    });
  }

  rows.sort((a, b) => b.value_base - a.value_base || a.symbol.localeCompare(b.symbol));

  const holdingsValue = round(
    rows.reduce((sum, r) => sum + r.value_base, 0),
    2,
  );
  for (const row of rows) {
    row.weight = holdingsValue > 0 ? round(row.value_base / holdingsValue, 6) : 0;
  }

  const byCurrency = new Map<string, { value_base: number; fx_rate: number; positions: number }>();
  for (const row of rows) {
    const entry = byCurrency.get(row.instrument_ccy) ?? {
      value_base: 0,
      fx_rate: row.fx_rate,
      positions: 0,
    };
    entry.value_base = round(entry.value_base + row.value_base, 2);
    entry.positions += 1;
    byCurrency.set(row.instrument_ccy, entry);
  }

  const cashNum = round(num(cash), 2);
  const storedHoldings = stored ? num(stored.holdings_value, Number.NaN) : Number.NaN;
  const storedTotal = stored ? num(stored.total_value, Number.NaN) : Number.NaN;
  const hasStored = Number.isFinite(storedHoldings) || Number.isFinite(storedTotal);

  const warnings: string[] = [];
  if (rows.length === 0) warnings.push("No positions were open on this day.");
  const missingFx = [...new Set(rows.filter((r) => r.fx_source === "assumed_identity").map((r) => r.fx_pair))];
  if (missingFx.length > 0) warnings.push(`Missing FX rate for ${missingFx.join(", ")}.`);
  const stale = rows.filter((r) => r.price_source === "avg_cost" || r.price_source === "missing");
  if (stale.length > 0) {
    warnings.push(`No market close for ${stale.map((r) => r.symbol).join(", ")}.`);
  }

  const ratio =
    hasStored && Number.isFinite(storedHoldings) && storedHoldings > 0
      ? round(holdingsValue / storedHoldings, 4)
      : null;
  if (ratio != null && (ratio >= 50 || ratio <= 0.02)) {
    warnings.push(
      `Computed holdings value is ${ratio}x the stored snapshot — that is a unit (pence vs pounds) mismatch, not drift.`,
    );
  }

  return {
    portfolio_id: portfolioId,
    date,
    base_ccy: base,
    rows,
    holdings_value: holdingsValue,
    cash: cashNum,
    total_value: round(holdingsValue + cashNum, 2),
    by_currency: [...byCurrency.entries()]
      .map(([currency, v]) => ({ currency, ...v }))
      .sort((a, b) => b.value_base - a.value_base),
    stored: hasStored
      ? {
          holdings_value: Number.isFinite(storedHoldings) ? round(storedHoldings, 2) : 0,
          total_value: Number.isFinite(storedTotal) ? round(storedTotal, 2) : 0,
        }
      : null,
    stored_ratio: ratio,
    warnings,
  };
}
