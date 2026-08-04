// Pure planner for **historical** equity-snapshot revaluation.
//
// `equity-snapshot-backfill.ts` only heals today's row and flat-lines gaps.
// Rows written *before* the LSE GBX/GBP unit fix landed still carry holdings
// values computed from raw pence quotes, so a portfolio holding LSE names
// reads up to 100x too high on every historical day — the tiles disagree with
// each other from day one even after today's row is corrected.
//
// This module recomputes each historical day deterministically, with no I/O:
//
//  1. Positions per day are reconstructed by rolling the *current* holdings
//     backwards through the fills ledger: qty_on(d) = qty_now − Σ signed fills
//     executed after d. Days before a position existed therefore hold zero.
//  2. Each position is marked with that day's close (carried forward from the
//     most recent earlier close, falling back to avg_cost), normalised through
//     the shared LSE unit rule so pence quotes are folded to pounds exactly
//     once.
//  3. Cash is treated as external truth and preserved from the stored row;
//     only `holdings_value` and `total_value` are recomputed.
//  4. Rows already matching the recomputed values are left alone, so the job
//     is idempotent and safe to re-run.

import { normalizeLseDisplayPriceToBase } from "./market-price-units";
import { instrumentCcyFor } from "./instrument-ccy-rules";

export type RevalueHolding = {
  symbol: string;
  quantity: number | string | null;
  avg_cost?: number | string | null;
  asset_class?: string | null;
  /** Settlement currency of the quote, e.g. GBP / USD. */
  instrument_ccy?: string | null;
  /** When the position was first opened; it contributes to no earlier day. */
  opened_at?: string | null;
};

export type RevalueFill = {
  symbol: string;
  side: string;
  quantity: number | string | null;
  /** Execution price in raw quote units (GBX for LSE listings). */
  fill_price?: number | string | null;
  /** ISO timestamp or date of execution. */
  filled_at: string;
};

/** An external deposit/withdrawal: positive credits the account. */
export type RevalueFundEvent = { at: string; amount: number | string | null };


export type RevalueSnapshot = {
  snapshot_date: string;
  cash: number | string | null;
  holdings_value?: number | string | null;
  total_value: number | string | null;
};

export type RevaluedSnapshot = {
  snapshot_date: string;
  cash: number;
  holdings_value: number;
  total_value: number;
  previous_holdings_value: number;
  previous_total_value: number;
  /** Ratio of old to new holdings value — ~100 flags a GBX/GBP unit bug. */
  ratio: number | null;
};

export type SkippedSnapshot = {
  snapshot_date: string;
  reason: "today" | "unattributable_history";
};

export type RevalueReport = {
  portfolio_id: string;
  daysScanned: number;
  rows: RevaluedSnapshot[];
  skipped: SkippedSnapshot[];
};

function num(value: number | string | null | undefined, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function day(value: string): string {
  return String(value ?? "").slice(0, 10);
}

const MIC_TO_YAHOO: Record<string, string> = {
  xlon: "L", xetr: "DE", xpar: "PA", xams: "AS", xmil: "MI",
  xmad: "MC", xswx: "SW", xtse: "TO", xhkg: "HK", xtks: "T",
  xasx: "AX", xsto: "ST", xcse: "CO", xhel: "HE", xose: "OL",
  xnas: "", xnys: "", arcx: "", bats: "",
};

/**
 * Every spelling a symbol may appear under across `holdings` (`ISF:xlon`),
 * `live_fills` / `price_cache` (`ISF.L`) and bare US tickers (`JNJ`).
 * Uppercase, most specific first.
 */
export function symbolKeys(symbol: string): string[] {
  const raw = String(symbol ?? "").trim().toUpperCase();
  if (!raw) return [];
  const keys = new Set<string>([raw]);
  const colon = raw.lastIndexOf(":");
  if (colon > 0) {
    const base = raw.slice(0, colon);
    const mic = raw.slice(colon + 1).toLowerCase();
    const suffix = MIC_TO_YAHOO[mic];
    keys.add(base);
    if (suffix) keys.add(`${base}.${suffix}`);
  } else {
    const dot = raw.lastIndexOf(".");
    if (dot > 0) keys.add(raw.slice(0, dot));
  }
  return [...keys];
}


/**
 * Settlement currency of a position, after the GBX→GBP fold. The listing
 * venue wins over `instrument_ccy`: stored rows frequently carry the
 * portfolio's base currency rather than the venue's (e.g. `JNJ:xnys` tagged
 * GBP), which would silently skip the FX conversion.
 */
export function instrumentCurrency(holding: RevalueHolding): string {
  return instrumentCcyFor(String(holding.symbol ?? ""), holding.instrument_ccy ?? null);
}

/** Canonical identity used to line fills up with holdings. */
export function positionKey(symbol: string): string {
  const keys = symbolKeys(symbol);
  // The shortest key is the bare root (ISF), shared by every spelling.
  return keys.reduce((a, b) => (b.length < a.length ? b : a), keys[0] ?? "");
}

/** Close on or before `date` for any spelling of `symbol`. */
export function closeOnOrBefore(
  prices: Map<string, Map<string, number>>,
  symbol: string,
  date: string,
): number | null {
  for (const key of symbolKeys(symbol)) {
    const series = prices.get(key);
    if (!series) continue;
    let best: number | null = null;
    let bestDate = "";
    for (const [d, close] of series) {
      if (d <= date && d >= bestDate && Number.isFinite(close) && close > 0) {
        best = close;
        bestDate = d;
      }
    }
    if (best != null) return best;
  }
  return null;
}

/**
 * Reconstruct the position book as it stood at the close of `date`, by undoing
 * every fill executed after that date against the current holdings.
 */
export function positionsOn(
  holdings: RevalueHolding[],
  fills: RevalueFill[],
  date: string,
): Map<string, { quantity: number; holding: RevalueHolding }> {
  const book = new Map<string, { quantity: number; holding: RevalueHolding }>();

  // `holdings.opened_at` is only trustworthy when nothing earlier is recorded
  // in the ledger: a broker re-sync rewrites the row and stamps *today*, which
  // would otherwise erase every day before the sync (holdings vanish, the tile
  // collapses to cash, and the next day reads as an implausible jump).
  const firstFill = new Map<string, string>();
  for (const f of fills) {
    const key = positionKey(f.symbol);
    const d = day(f.filled_at);
    if (!key || !d) continue;
    const prev = firstFill.get(key);
    if (!prev || d < prev) firstFill.set(key, d);
  }

  for (const h of holdings) {
    const key = positionKey(h.symbol);
    if (!key) continue;
    // A position cannot exist before it was opened, even when the fills ledger
    // is incomplete for that leg (older sim trades predate `live_fills`).
    const stamped = h.opened_at ? day(h.opened_at) : null;
    const ledger = firstFill.get(key) ?? null;
    const openedOn =
      stamped && ledger ? (ledger < stamped ? ledger : stamped) : (ledger ?? stamped);
    if (openedOn && openedOn > date) continue;
    const prev = book.get(key);
    book.set(key, {
      quantity: (prev?.quantity ?? 0) + num(h.quantity),
      holding: prev?.holding ?? h,
    });
  }

  for (const f of fills) {
    if (day(f.filled_at) <= date) continue;
    const key = positionKey(f.symbol);
    if (!key) continue;
    const qty = num(f.quantity);
    if (!(qty > 0)) continue;
    const signed = String(f.side ?? "").toLowerCase() === "sell" ? -qty : qty;
    const entry = book.get(key);
    // Undo the later fill: a buy after `date` means we held that much less.
    if (entry) entry.quantity -= signed;
    else book.set(key, { quantity: -signed, holding: { symbol: f.symbol, quantity: 0 } });
  }
  for (const [key, entry] of book) {
    if (!(entry.quantity > 1e-9)) book.delete(key);
  }
  return book;
}

/** Mark a reconstructed book to that day's normalised closes. */
export function valuePositionsOn(
  book: Map<string, { quantity: number; holding: RevalueHolding }>,
  prices: Map<string, Map<string, number>>,
  date: string,
  /** Instrument currency → portfolio base currency multipliers. */
  fx: Map<string, number> = new Map(),
): number {
  let total = 0;
  for (const { quantity, holding } of book.values()) {
    const raw = closeOnOrBefore(prices, holding.symbol, date);
    const px = raw != null
      ? normalizeLseDisplayPriceToBase(holding.symbol, raw, holding.asset_class)
      : normalizeLseDisplayPriceToBase(
          holding.symbol,
          num(holding.avg_cost),
          holding.asset_class,
        );
    if (!(px > 0)) continue;
    const rate = fx.get(instrumentCurrency(holding).toUpperCase()) ?? 1;
    total += quantity * px * (Number.isFinite(rate) && rate > 0 ? rate : 1);
  }
  return round2(total);
}

/**
 * Reconstruct the cash balance at the close of `date` by undoing every fill
 * and funding event recorded after it, starting from a known-good anchor
 * (normally the most recent broker-synced balance).
 *
 * Stored historical `cash` is frequently the *current* balance stamped onto an
 * old row by a repair job, which makes a correctly re-marked history look like
 * an implausible jump. Returns `null` when the ledger cannot explain the day —
 * any priceless fill, or a balance that rolls back through zero — so callers
 * keep the stored figure rather than invent one.
 */
export function cashOn(
  anchorCash: number,
  fills: RevalueFill[],
  fundEvents: RevalueFundEvent[],
  date: string,
  fx: Map<string, number> = new Map(),
): number | null {
  let cash = anchorCash;
  if (!Number.isFinite(cash)) return null;

  for (const f of fills) {
    if (day(f.filled_at) <= date) continue;
    const qty = num(f.quantity);
    if (!(qty > 0)) continue;
    // `live_fills.fill_price` is stored in the instrument's settlement
    // currency (the legacy GBX rows were rescaled), so it must NOT go through
    // the LSE pence rule again — that would shrink every London leg 100x and
    // leave the rolled-back balance far too small.
    const px = num(f.fill_price, Number.NaN);
    if (!Number.isFinite(px) || px <= 0) return null;

    const ccy = instrumentCcyFor(String(f.symbol ?? ""), null).toUpperCase();
    const rate = fx.get(ccy);
    const notional = qty * px * (Number.isFinite(rate) && (rate ?? 0) > 0 ? rate! : 1);
    // Undo it: a later buy means we still held that cash on `date`.
    cash += String(f.side ?? "").toLowerCase() === "sell" ? -notional : notional;
  }

  for (const e of fundEvents) {
    if (day(e.at) <= date) continue;
    const amount = num(e.amount, Number.NaN);
    if (!Number.isFinite(amount)) return null;
    cash -= amount;
  }

  if (!Number.isFinite(cash) || cash < 0) return null;
  return round2(cash);
}


export function planHistoricalRevaluation({
  portfolioId,
  snapshots,
  holdings,
  fills,
  prices,
  inception,
  today,
  fx = new Map<string, number>(),
  fundEvents = [],
}: {
  portfolioId: string;
  snapshots: RevalueSnapshot[];
  holdings: RevalueHolding[];
  fills: RevalueFill[];
  prices: Map<string, Map<string, number>>;
  inception?: string | null;
  /** Rows on/after this date are left to the live mark-to-market path. */
  today?: string | null;
  /** Instrument currency → portfolio base currency multipliers. */
  fx?: Map<string, number>;
  /** External deposits/withdrawals, used to roll historical cash back. */
  fundEvents?: RevalueFundEvent[];
}): RevalueReport {
  const rows: RevaluedSnapshot[] = [];
  const skipped: SkippedSnapshot[] = [];
  const sorted = [...snapshots]
    .map((s) => ({ ...s, snapshot_date: day(s.snapshot_date) }))
    .filter((s) => !inception || s.snapshot_date >= day(inception))
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));

  // Anchor for historical cash: the newest stored balance, which is the one a
  // broker sync actually refreshed.
  const anchor = sorted.length > 0 ? sorted[sorted.length - 1]! : null;
  const anchorCash = anchor ? num(anchor.cash, Number.NaN) : Number.NaN;
  const anchorDate = anchor?.snapshot_date ?? "";

  for (const snap of sorted) {
    const date = snap.snapshot_date;
    // Today's row is owned by the live backfill, which marks against fresh
    // quotes rather than the last cached close. Never fight it.
    if (today && date >= day(today)) {
      skipped.push({ snapshot_date: date, reason: "today" });
      continue;
    }
    const book = positionsOn(holdings, fills, date);
    const holdingsValue = valuePositionsOn(book, prices, date, fx);

    const storedTotal = num(snap.total_value, Number.NaN);
    const rawCash = num(snap.cash, Number.NaN);
    const rawHoldings = num(snap.holdings_value, Number.NaN);
    const storedCash = Number.isFinite(rawCash)
      ? rawCash
      : Number.isFinite(rawHoldings) && Number.isFinite(storedTotal)
        ? storedTotal - rawHoldings
        : 0;
    // Repair jobs stamp today's balance onto old rows, so prefer the balance
    // the ledger implies; fall back to the stored figure when it can't be
    // reconstructed.
    const rolledCash =
      Number.isFinite(anchorCash) && date < anchorDate
        ? cashOn(anchorCash, fills, fundEvents, date, fx)
        : null;
    const cash = rolledCash ?? storedCash;
    const previousHoldings = Number.isFinite(rawHoldings)
      ? rawHoldings
      : Number.isFinite(storedTotal)
        ? storedTotal - storedCash
        : 0;
    const total = round2(cash + holdingsValue);


    // The ledger cannot explain a day that held value we can no longer
    // reconstruct (positions closed before `live_fills` existed). Writing a
    // zero there would erase real history, so leave it and report it.
    if (book.size === 0 && round2(previousHoldings) > 0) {
      skipped.push({ snapshot_date: date, reason: "unattributable_history" });
      continue;
    }

    if (
      round2(previousHoldings) === holdingsValue &&
      Number.isFinite(storedTotal) &&
      round2(storedTotal) === total
    ) {
      continue;
    }

    rows.push({
      snapshot_date: date,
      cash: round2(cash),
      holdings_value: holdingsValue,
      total_value: total,
      previous_holdings_value: round2(previousHoldings),
      previous_total_value: Number.isFinite(storedTotal) ? round2(storedTotal) : 0,
      ratio: holdingsValue > 0 ? round2(previousHoldings / holdingsValue) : null,
    });
  }

  return { portfolio_id: portfolioId, daysScanned: sorted.length, rows, skipped };
}
