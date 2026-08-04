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

/**
 * A position that appeared in `holdings` without any buy fill behind it —
 * typically a broker sync importing positions the app never executed. Its
 * cost is the only record of the cash that left the account when it opened.
 *
 * `unresolved` marks an opening whose cash cost cannot be trusted (no open
 * date, no usable cost, or an instrument currency with no FX rate). Rolling
 * cash back past one of those would invent a balance, so `cashOn` refuses the
 * whole day instead.
 */
export type RevalueOpening = {
  at: string;
  /** Position key this opening belongs to, so a day that already counts the
   *  position in its book can refuse the cash credit. */
  key?: string;
  costBase: number;
  /** Quantity of the position the fills ledger does not account for. */
  unbackedQuantity?: number;
  unresolved?: boolean;
  reason?: "no_open_date" | "no_cost" | "no_fx";
};





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
  /** True when no row existed for this day and one was reconstructed. */
  inserted?: boolean;
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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar day of a timestamp, or `null` when it is missing or malformed.
 *
 * Ledger rows occasionally carry an empty, partial, or non-ISO `filled_at`
 * (an out-of-order import, a hand-repaired row). `day()` would turn those into
 * `""`, which sorts before every date and therefore silently reads as "already
 * settled" — the fill then vanishes from every rollback instead of being
 * flagged. Callers that reconstruct cash must treat this as unattributable.
 */
export function parseDay(value: string | null | undefined): string | null {
  const d = String(value ?? "").trim().slice(0, 10);
  return ISO_DAY.test(d) ? d : null;
}

/**
 * Multiplier from `ccy` into the portfolio's base currency.
 *
 * Returns `null` when the currency is genuinely unknown, so cash rollbacks can
 * refuse the day rather than silently applying 1.0 and mixing a USD leg into a
 * GBP balance. An empty map means "no FX supplied at all" (single-currency
 * callers and older tests), which stays 1.0.
 */
export function resolveRate(
  fx: Map<string, number>,
  ccy: string,
  baseCcy?: string | null,
): number | null {
  const code = String(ccy ?? "").toUpperCase();
  const base = String(baseCcy ?? "").toUpperCase();
  if (base && code === base) return 1;
  const rate = fx.get(code);
  if (Number.isFinite(rate) && (rate ?? 0) > 0) return rate!;
  if (fx.size === 0) return 1;
  return null;
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
    const d = parseDay(f.filled_at);
    if (!key || !d) continue;
    const prev = firstFill.get(key);
    if (!prev || d < prev) firstFill.set(key, d);
  }

  for (const h of holdings) {
    const key = positionKey(h.symbol);
    if (!key) continue;
    // A position cannot exist before it was opened, even when the fills ledger
    // is incomplete for that leg (older sim trades predate `live_fills`).
    const stamped = parseDay(h.opened_at);
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
    // Undated fills cannot be placed on either side of `date`; leaving the
    // book untouched keeps the position count stable (cash reconstruction
    // separately refuses the day).
    const d = parseDay(f.filled_at);
    if (!d || d <= date) continue;
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
 * The part of each held position that the fills ledger cannot account for.
 *
 * A linked broker account can gain positions the app did not execute (manual
 * trades, transfers, a first sync of an account that already held stock). The
 * cash those purchases consumed is invisible to `cashOn`, which then leaves
 * every earlier day carrying *today's* depleted balance while showing no
 * positions — exactly the shape that reads as an implausible jump on the day
 * the positions appear.
 *
 * Backing is measured in **quantity**, not presence: a leg whose ledger holds
 * one 120-share buy against 704 shares held is 584 shares unbacked, and only
 * that residual's cost is handed back. Treating any single buy fill as full
 * backing under-credits the rollback and reintroduces the jump.
 *
 * `avg_cost` is stored in the instrument's settlement currency (post the
 * fill-record repair), so it is converted with FX only — never through the LSE
 * pence rule, which would shrink a London leg 100x. A leg whose currency has
 * no rate, whose cost is missing, or whose open date is unusable is emitted as
 * `unresolved` so `cashOn` can refuse the day rather than guess.
 */
export function unbackedOpenings(
  holdings: RevalueHolding[],
  fills: RevalueFill[],
  fx: Map<string, number> = new Map(),
  baseCcy?: string | null,
): RevalueOpening[] {
  // Net signed quantity per position: sells consume backing just as buys
  // create it, so a bought-then-sold-then-resynced leg is unbacked again.
  const backed = new Map<string, number>();
  for (const f of fills) {
    const key = positionKey(f.symbol);
    if (!key) continue;
    const qty = num(f.quantity);
    if (!(qty > 0)) continue;
    const signed = String(f.side ?? "").toLowerCase() === "sell" ? -qty : qty;
    backed.set(key, (backed.get(key) ?? 0) + signed);
  }

  // Several rows can share one position key (`ISF.L` and `ISF:xlon`); the
  // ledger backs the combined leg, so consume backing across them in open
  // order and let the earliest row absorb it first.
  const rows = holdings
    .map((h) => ({ h, key: positionKey(h.symbol), at: parseDay(h.opened_at) }))
    .filter((r) => r.key !== "")
    .sort((a, b) => (a.at ?? "9999-12-31").localeCompare(b.at ?? "9999-12-31"));

  const remaining = new Map(backed);
  const out: RevalueOpening[] = [];

  for (const { h, key, at } of rows) {
    const qty = num(h.quantity);
    if (!(qty > 0)) continue;

    const avail = Math.max(0, remaining.get(key) ?? 0);
    const consumed = Math.min(qty, avail);
    remaining.set(key, avail - consumed);
    const unbackedQty = qty - consumed;
    // Sub-share residues are rounding noise from fractional sim fills, not a
    // real broker import; crediting them back would only add jitter.
    if (!(unbackedQty > 1e-6)) continue;

    const cost = num(h.avg_cost);
    if (!at) {
      out.push({ at: "", key, costBase: 0, unbackedQuantity: unbackedQty, unresolved: true, reason: "no_open_date" });
      continue;
    }
    if (!(cost > 0)) {
      out.push({ at, key, costBase: 0, unbackedQuantity: unbackedQty, unresolved: true, reason: "no_cost" });
      continue;
    }
    const rate = resolveRate(fx, instrumentCurrency(h), baseCcy);
    if (rate == null) {
      out.push({ at, key, costBase: 0, unbackedQuantity: unbackedQty, unresolved: true, reason: "no_fx" });
      continue;
    }
    out.push({ at, key, costBase: unbackedQty * cost * rate, unbackedQuantity: unbackedQty });
  }

  return out;
}

/**
 * Reconstruct the cash balance at the close of `date` by undoing every fill
 * and funding event recorded after it, starting from a known-good anchor
 * (normally the most recent broker-synced balance).
 *
 * Stored historical `cash` is frequently the *current* balance stamped onto an
 * old row by a repair job, which makes a correctly re-marked history look like
 * an implausible jump. Returns `null` when the ledger cannot explain the day,
 * so callers keep the stored figure rather than invent one:
 *
 *  - a fill with no price, no quantity, or a malformed/missing timestamp;
 *  - a leg in a currency with no FX rate (mixing USD into a GBP balance);
 *  - an `unresolved` opening (cost, date, or FX unknown);
 *  - a funding event with a malformed timestamp or amount;
 *  - a balance that rolls back through zero.
 *
 * Anything dated after `anchorDate` is ignored rather than undone: the anchor
 * balance predates it, so rolling it back would double-count. This is what
 * keeps an out-of-order or future-stamped fill from shifting the whole series.
 */
export function cashOn(
  anchorCash: number,
  fills: RevalueFill[],
  fundEvents: RevalueFundEvent[],
  date: string,
  fx: Map<string, number> = new Map(),
  openings: RevalueOpening[] = [],
  options: { anchorDate?: string | null; baseCcy?: string | null } = {},
): number | null {
  let cash = anchorCash;
  if (!Number.isFinite(cash)) return null;
  const on = parseDay(date);
  if (!on) return null;
  const anchorDay = parseDay(options.anchorDate);
  const after = (d: string) => d > on && (!anchorDay || d <= anchorDay);

  for (const f of fills) {
    const d = parseDay(f.filled_at);
    // A fill we cannot place in time cannot be undone — and silently treating
    // it as historical would drop real cash movement from every day.
    if (!d) return null;
    if (!after(d)) continue;
    const qty = num(f.quantity, Number.NaN);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    // `live_fills.fill_price` is stored in the instrument's settlement
    // currency (the legacy GBX rows were rescaled), so it must NOT go through
    // the LSE pence rule again — that would shrink every London leg 100x and
    // leave the rolled-back balance far too small.
    const px = num(f.fill_price, Number.NaN);
    if (!Number.isFinite(px) || px <= 0) return null;

    const ccy = instrumentCcyFor(String(f.symbol ?? ""), null);
    const rate = resolveRate(fx, ccy, options.baseCcy);
    if (rate == null) return null;
    const notional = qty * px * rate;
    if (!Number.isFinite(notional)) return null;
    // Undo it: a later buy means we still held that cash on `date`.
    cash += String(f.side ?? "").toLowerCase() === "sell" ? -notional : notional;
  }

  // Positions with no buy fill behind them: give their cost back to the days
  // before they appeared, or those days read as cash-poor and position-free.
  for (const o of openings) {
    const d = parseDay(o.at);
    if (o.unresolved) {
      // Undateable: it could have consumed cash at any point in the window, so
      // no day can be trusted. Otherwise it only spoils the days *before* it
      // opened; days on/after it, and days past the anchor, stay reconstructible.
      if (!d) return null;
      if (after(d)) return null;
      continue;
    }
    if (!d || !after(d)) continue;
    if (!Number.isFinite(o.costBase) || o.costBase <= 0) continue;
    cash += o.costBase;
  }


  for (const e of fundEvents) {
    const d = parseDay(e.at);
    if (!d) return null;
    if (!after(d)) continue;
    const amount = num(e.amount, Number.NaN);
    if (!Number.isFinite(amount)) return null;
    cash -= amount;
  }

  if (!Number.isFinite(cash) || cash < 0) return null;
  return round2(cash);
}

/**
 * Every calendar day from `from` to `to`, inclusive. Bounded so a malformed
 * date can never spin: a reconstruction window wider than ~10 years is a bug,
 * not a request.
 */
export function enumerateDays(from: string, to: string): string[] {
  const start = parseDay(from);
  const end = parseDay(to);
  if (!start || !end || start > end) return [];
  const out: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) return [];
  while (cursor <= last && out.length < 4000) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
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
  baseCcy = null,
  fillGaps = false,



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
  /** Portfolio base currency; legs in it need no FX rate to be trusted. */
  baseCcy?: string | null;
  /**
   * Reconstruct days that have no stored row at all, between inception and the
   * newest stored row. A gap breaks the chart series: the line jumps straight
   * from inception to the first surviving snapshot, so a week of real trading
   * simply vanishes. The reconstructed days use exactly the same position
   * rollback and cash rollback as a stored day, and are skipped whenever the
   * ledger cannot explain them.
   */
  fillGaps?: boolean;

}): RevalueReport {
  const rows: RevaluedSnapshot[] = [];
  const skipped: SkippedSnapshot[] = [];
  const stored = [...snapshots]
    .map((s) => ({ ...s, snapshot_date: day(s.snapshot_date) }))
    .filter((s) => !inception || s.snapshot_date >= day(inception))
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));

  const present = new Set(stored.map((s) => s.snapshot_date));
  const synthetic = new Set<string>();
  const sorted = [...stored];
  if (fillGaps && stored.length > 0) {
    const from = inception ? day(inception) : stored[0]!.snapshot_date;
    const to = stored[stored.length - 1]!.snapshot_date;
    for (const d of enumerateDays(from, to)) {
      if (present.has(d)) continue;
      synthetic.add(d);
      sorted.push({ snapshot_date: d, cash: null, holdings_value: null, total_value: null });
    }
    sorted.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  }

  // Anchor for historical cash: the newest *stored* balance, which is the one
  // a broker sync actually refreshed. A reconstructed day must never become
  // the anchor for the days before it.
  const anchor = stored.length > 0 ? stored[stored.length - 1]! : null;
  const anchorCash = anchor ? num(anchor.cash, Number.NaN) : Number.NaN;
  const anchorDate = anchor?.snapshot_date ?? "";
  // Broker-imported positions carry no fill, so their cost has to be handed
  // back to the days before they appeared.
  const openings = unbackedOpenings(holdings, fills, fx, baseCcy);




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
    // An opening only hands its cost back to days that do NOT already carry
    // the position. When a later sell leaves a stale `holdings` row looking
    // unbacked, crediting its cost on a day whose book still values the
    // position counts the same money twice and inflates the whole gap.
    const dayOpenings = openings.filter((o) => !o.key || !book.has(o.key));
    const rolledCash =
      Number.isFinite(anchorCash) && date < anchorDate
        ? cashOn(anchorCash, fills, fundEvents, date, fx, dayOpenings, {
            anchorDate,
            baseCcy,
          })
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
    // zero there would erase real history, so leave it and report it — but
    // only when the unexplained stub is material: a rounding-scale residue
    // must not block a day whose cash we *can* reconstruct.
    const materialResidue =
      Number.isFinite(storedTotal) && storedTotal > 0
        ? previousHoldings / storedTotal > 0.01
        : previousHoldings > 0;
    if (book.size === 0 && round2(previousHoldings) > 0 && materialResidue) {

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
      ...(synthetic.has(date) ? { inserted: true } : {}),

    });
  }

  return { portfolio_id: portfolioId, daysScanned: sorted.length, rows, skipped };
}
