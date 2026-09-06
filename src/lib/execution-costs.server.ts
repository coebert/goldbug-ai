/**
 * What this account really pays to deal, measured per symbol from its own
 * fills — live.
 *
 * The offline model fit used to price tickets once, at fit time. That is too
 * slow a clock for a gate that has to refuse a trade today: costs move as the
 * spread widens, as a name's liquidity dries up, and as the price itself moves
 * (commission floors and the stamp-duty threshold bite differently on a £250
 * ticket than on a £2,500 one). So the same ticket-by-ticket pricing runs on
 * every engine tick, per symbol, and the result is stored in
 * `symbol_execution_costs` and used as the per-name floor under the modelled
 * friction in the net-edge gate.
 *
 * Method, per ticket (one broker order, partial fills collapsed):
 *   charge = invoiced contract note when synced, else the tariff model priced
 *            on the real fill size, so small tickets carry their fixed floor;
 *   slippage = the gap between the day's printed close and the price the fill
 *            actually came back at, signed against the account;
 * both in the instrument's own currency, with pence-quoted LSE prices handled.
 * A symbol with few fills is shrunk toward the account-wide figure so one bad
 * print cannot price every future trade in that name.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { priceSymbolVariants } from "./price-symbol";
import { estimateTradeCosts } from "./trade-viability-gate";
import { inferSaxoCurrency } from "./saxo-fees";

export const DEFAULT_ONE_WAY_COST_BPS = 15;

export function baseSymbol(symbol: string): string {
  return (symbol.split(":")[0] ?? symbol).trim().toUpperCase();
}

// --------------------------------------------------------------------------
// Dealing costs actually paid on this account
//
// A trade costs more than its commission. What this book really loses on a
// round trip is (a) the invoiced charges on the contract note — commission,
// exchange fees, stamp duty and the rest — plus (b) the gap between the price
// the tape printed that day and the price this account was actually filled at.
// Both are measured here from `live_fills`, per symbol and per side, because a
// UK single stock pays stamp duty on the way in and an ETF does not.
// --------------------------------------------------------------------------

export type SymbolCost = {
  buyBps: number;
  sellBps: number;
  fills: number;
  /** Broker orders (not partial fills) behind the figure. */
  tickets: number;
  invoicedFills: number;
  firstFillAt: string | null;
  lastFillAt: string | null;
};

export type CostModel = {
  bySymbol: Map<string, SymbolCost>;
  /** Account-wide one-way cost used where a symbol has no fills of its own. */
  medianBps: number;
  /** Account-wide split, for reporting. */
  feeBps: number;
  slippageBps: number;
  calibrated: number;
  fills: number;
  invoicedFills: number;
  slippageFills: number;
  /** Rate the broker actually invoiced, per pound dealt; null with no notes in. */
  invoicedChargeBps: number | null;
  /** Share of dealt notional covered by real contract notes (0-1). */
  invoicedNotionalShare: number;
};


/** Fills at least this many before a symbol's own cost is trusted outright. */
const COST_SHRINK_FILLS = 4;
const MAX_ONE_WAY_BPS = 400;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * Fills are booked in the instrument's own currency; LSE closes are quoted in
 * pence. Rescale when the two are a clean factor of 100 apart so a currency
 * convention never masquerades as 9,900bps of slippage.
 */
function alignUnits(fill: number, close: number): number | null {
  if (!(fill > 0) || !(close > 0)) return null;
  const r = close / fill;
  if (r > 50 && r < 200) return close / 100;
  if (r > 1 / 200 && r < 1 / 50) return close * 100;
  if (r > 0.5 && r < 2) return close;
  return null; // too far apart to trust — skip this fill
}

/**
 * True when the fill price is quoted in pence. UK closes are stored in pence,
 * so when the fill agrees with the tape it is pence too; when the tape is a
 * clean 100x above it, the fill was already booked in pounds.
 */
function isPenceQuoted(
  symbol: string,
  price: number,
  rawClose: number | null,
  alignedClose: number | null,
): boolean {
  if (inferSaxoCurrency(symbol) !== "GBP") return false;
  if (rawClose !== null && alignedClose !== null) return Math.abs(alignedClose - rawClose) < 1e-9;
  return price > 20; // no tape to compare with: UK pound prices above £20 are rare
}

export async function computeExecutionCosts(portfolioIds: string[]): Promise<CostModel> {
  // One ticket = one order. Partial fills are slices of the same instruction
  // and share its commission, so they are aggregated before the ticket is
  // priced — otherwise a 2-share slice looks like it paid the whole floor.
  type Ticket = {
    symbol: string;
    side: "buy" | "sell";
    date: string;
    quantity: number;
    price: number;
    /** Itemised broker charges in the instrument's currency, when invoiced. */
    invoicedCharge: number | null;
  };
  type FillRow = {
    orderKey: string;
    symbol: string;
    side: "buy" | "sell";
    date: string;
    quantity: number;
    price: number;
    /** Itemised broker charges in the instrument's currency, when invoiced. */
    invoicedCharge: number | null;
  };
  const rawFills: FillRow[] = [];

  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from("live_fills")
      .select(
        "order_id, symbol, side, quantity, fill_price, fee, fee_commission, fee_exchange, fee_tax, fee_other, fee_source, filled_at",
      )
      .in("portfolio_id", portfolioIds)
      .range(page * 1000, page * 1000 + 999);
    if (error) break; // costs are a refinement, never a reason to fail the fit
    for (const r of data ?? []) {
      const qty = Math.abs(Number(r.quantity) || 0);
      const px = Number(r.fill_price) || 0;
      if (!(qty > 0) || !(px > 0)) continue;

      // The broker's itemised contract note, when it has actually been synced.
      const parts = [r.fee_commission, r.fee_exchange, r.fee_tax, r.fee_other]
        .map((v) => Math.abs(Number(v) || 0))
        .reduce((a, b) => a + b, 0);
      const source = String(r.fee_source ?? "").toLowerCase();
      const synced = source !== "" && source !== "none" && source !== "modelled";
      const charge = parts > 0 ? parts : Math.abs(Number(r.fee) || 0);

      const at = r.filled_at ? new Date(r.filled_at as string) : null;
      const date = at && !Number.isNaN(at.getTime()) ? at.toISOString().slice(0, 10) : "";
      const sym = baseSymbol(String(r.symbol ?? ""));
      const side = String(r.side ?? "").toLowerCase() === "sell" ? "sell" : "buy";
      rawFills.push({
        orderKey: r.order_id ? String(r.order_id) : `${sym}|${side}|${date}`,
        symbol: sym,
        side,
        date,
        quantity: qty,
        price: px,
        invoicedCharge: synced && charge > 0 ? charge : null,
      });
    }
    if ((data?.length ?? 0) < 1000) break;
  }

  // --- collapse partial fills into the ticket the broker actually charged --
  const byOrder = new Map<string, Ticket & { notional: number; charged: number; anyInvoiced: boolean }>();
  for (const f of rawFills) {
    const cur = byOrder.get(f.orderKey) ?? {
      symbol: f.symbol, side: f.side, date: f.date,
      quantity: 0, price: 0, invoicedCharge: null,
      notional: 0, charged: 0, anyInvoiced: false,
    };
    cur.quantity += f.quantity;
    cur.notional += f.quantity * f.price;
    if (f.invoicedCharge !== null) { cur.charged += f.invoicedCharge; cur.anyInvoiced = true; }
    byOrder.set(f.orderKey, cur);
  }
  const fills: Ticket[] = [];
  for (const t of byOrder.values()) {
    if (!(t.quantity > 0) || !(t.notional > 0)) continue;
    fills.push({
      symbol: t.symbol, side: t.side, date: t.date,
      quantity: t.quantity,
      price: t.notional / t.quantity, // volume-weighted average fill price
      invoicedCharge: t.anyInvoiced ? t.charged : null,
    });
  }

  // --- the day's tape, to measure what the fill actually gave up -----------
  const closeByKey = new Map<string, number>();
  const symbols = Array.from(new Set(fills.map((f) => f.symbol))).filter(Boolean);
  const dates = Array.from(new Set(fills.map((f) => f.date))).filter(Boolean).sort();
  if (symbols.length > 0 && dates.length > 0) {
    const variants = Array.from(new Set(symbols.flatMap((s) => priceSymbolVariants(s))));
    for (let page = 0; ; page++) {
      const { data, error } = await supabaseAdmin
        .from("price_cache")
        .select("symbol, price_date, close")
        .in("symbol", variants)
        .gte("price_date", dates[0]!)
        .lte("price_date", dates[dates.length - 1]!)
        .range(page * 1000, page * 1000 + 999);
      if (error) break;
      for (const r of data ?? []) {
        const close = Number(r.close) || 0;
        if (!(close > 0)) continue;
        closeByKey.set(`${baseSymbol(String(r.symbol))}|${String(r.price_date)}`, close);
      }
      if ((data?.length ?? 0) < 1000) break;
    }
  }

  const bySide = new Map<string, { fills: number; chargeW: number; chargeBps: number; slips: number[] }>();
  /** Ticket counts and the window of activity, per symbol. */
  const meta = new Map<
    string,
    { tickets: number; invoiced: number; first: string | null; last: string | null }
  >();
  const allCharge: number[] = [];
  let chargeNotional = 0;
  let chargeWeighted = 0;
  const allSlip: number[] = [];
  let invoicedFills = 0;
  let slippageFills = 0;
  // What the broker actually invoiced, kept apart from the tariff estimate so
  // the real contract notes can set the floor for tickets that have none.
  let invoicedNotional = 0;
  let invoicedWeighted = 0;
  let modelledNotional = 0;

  /** Every ticket priced once, so invoiced reality can be applied afterwards. */
  type PricedTicket = {
    ticket: Ticket;
    notionalNative: number;
    chargeBps: number;
    invoiced: boolean;
    close: number | null;
  };
  const priced: PricedTicket[] = [];

  for (const f of fills) {
    const m = meta.get(f.symbol) ?? { tickets: 0, invoiced: 0, first: null, last: null };
    m.tickets++;
    if (f.invoicedCharge !== null) m.invoiced++;
    if (f.date) {
      if (m.first === null || f.date < m.first) m.first = f.date;
      if (m.last === null || f.date > m.last) m.last = f.date;
    }
    meta.set(f.symbol, m);

    const rawClose = f.date ? closeByKey.get(`${f.symbol}|${f.date}`) : undefined;
    const close = rawClose === undefined ? null : alignUnits(f.price, rawClose);

    // Charges as a rate. Invoiced when the contract note is in; otherwise the
    // same tiered commission / stamp duty / levy schedule the live gate prices
    // every ticket with — applied to the real fill size, so a small ticket
    // carries the fixed floor it genuinely pays.
    const notionalNative = f.quantity * f.price;
    let chargeBps: number;
    const invoiced = f.invoicedCharge !== null;
    if (invoiced) {
      invoicedFills++;
      chargeBps = (f.invoicedCharge! / notionalNative) * 10_000;
      if (Number.isFinite(chargeBps) && chargeBps >= 0 && chargeBps <= MAX_ONE_WAY_BPS) {
        invoicedNotional += notionalNative;
        invoicedWeighted += chargeBps * notionalNative;
      }
    } else {
      // Commission floors are set in major currency units; LSE prices are in
      // pence, so convert before pricing the ticket or the floor disappears.
      const pence = isPenceQuoted(f.symbol, f.price, rawClose ?? null, close);
      const priceMajor = pence ? f.price / 100 : f.price;
      const modelled = estimateTradeCosts({
        symbol: f.symbol,
        side: f.side,
        quantity: f.quantity,
        price: priceMajor,
        assetClass: null,
      });
      chargeBps = Number.isFinite(modelled.oneWayBps) ? modelled.oneWayBps : DEFAULT_ONE_WAY_COST_BPS;
      if (Number.isFinite(chargeBps) && chargeBps >= 0) modelledNotional += notionalNative;
    }
    priced.push({ ticket: f, notionalNative, chargeBps, invoiced, close });
  }

  // The rate the broker really charged, per pound dealt. Whenever the invoices
  // are in, they — not the published tariff — set the floor for tickets that
  // have not been invoiced yet: the tariff systematically under-states what
  // this account is billed, and a gate priced on the tariff lets through
  // trades that cannot pay for themselves.
  const invoicedChargeBps = invoicedNotional > 0 ? invoicedWeighted / invoicedNotional : null;

  for (const p of priced) {
    const f = p.ticket;
    const key = `${f.symbol}|${f.side}`;
    const cur = bySide.get(key) ?? { fills: 0, chargeW: 0, chargeBps: 0, slips: [] };
    cur.fills++;
    const chargeBps =
      !p.invoiced && invoicedChargeBps !== null
        ? Math.max(p.chargeBps, invoicedChargeBps)
        : p.chargeBps;
    if (Number.isFinite(chargeBps) && chargeBps >= 0 && chargeBps <= MAX_ONE_WAY_BPS) {
      cur.chargeW += p.notionalNative;
      cur.chargeBps += chargeBps * p.notionalNative;
      allCharge.push(chargeBps);
      chargeNotional += p.notionalNative;
      chargeWeighted += chargeBps * p.notionalNative;
    }

    if (p.close !== null) {
      const signed = f.side === "buy" ? f.price - p.close : p.close - f.price;
      const bps = (signed / p.close) * 10_000;
      if (Number.isFinite(bps) && Math.abs(bps) <= MAX_ONE_WAY_BPS) {
        cur.slips.push(bps);
        allSlip.push(bps);
        slippageFills++;
      }
    }
    bySide.set(key, cur);
  }


  // Weighted by notional, not per ticket: what this book pays per pound put to
  // work. A handful of £10 test tickets pay enormous rates but move no money,
  // and should not set the hurdle for every future trade.
  const accountCharge =
    chargeNotional > 0
      ? chargeWeighted / chargeNotional
      : (median(allCharge) ?? DEFAULT_ONE_WAY_COST_BPS);
  // Slippage is two-sided noise around a real average cost; the median keeps a
  // single bad print from setting the price of every future trade.
  const accountSlip = Math.max(0, median(allSlip) ?? 0);
  const accountOneWay = Math.min(MAX_ONE_WAY_BPS, accountCharge + accountSlip);

  const sideCost = (symbol: string, side: string): number => {
    const v = bySide.get(`${symbol}|${side}`);
    if (!v || v.fills === 0) return accountOneWay;
    const charge = v.chargeW > 0 ? v.chargeBps / v.chargeW : accountCharge;
    const slip = Math.max(0, median(v.slips) ?? accountSlip);
    const own = charge + slip;
    // Shrink a thin sample toward what the account pays on average.
    const w = v.fills / (v.fills + COST_SHRINK_FILLS);
    return Math.min(MAX_ONE_WAY_BPS, w * own + (1 - w) * accountOneWay);
  };

  const bySymbol = new Map<string, SymbolCost>();
  for (const sym of symbols) {
    const buys = bySide.get(`${sym}|buy`)?.fills ?? 0;
    const sells = bySide.get(`${sym}|sell`)?.fills ?? 0;
    if (buys + sells === 0) continue;
    const m = meta.get(sym);
    bySymbol.set(sym, {
      buyBps: sideCost(sym, "buy"),
      sellBps: sideCost(sym, "sell"),
      fills: buys + sells,
      tickets: m?.tickets ?? buys + sells,
      invoicedFills: m?.invoiced ?? 0,
      firstFillAt: m?.first ?? null,
      lastFillAt: m?.last ?? null,
    });
  }


  return {
    bySymbol,
    medianBps: accountOneWay,
    feeBps: Math.round(accountCharge * 10) / 10,
    slippageBps: Math.round(accountSlip * 10) / 10,
    calibrated: bySymbol.size,
    fills: rawFills.length,
    invoicedFills,
    slippageFills,
    invoicedChargeBps:
      invoicedChargeBps === null ? null : Math.round(invoicedChargeBps * 10) / 10,
    invoicedNotionalShare:
      invoicedNotional + modelledNotional > 0
        ? invoicedNotional / (invoicedNotional + modelledNotional)
        : 0,
  };
}


/** Round trip = what this account pays getting in, plus what it pays getting out. */
export function roundTripCostFrac(costs: CostModel, symbol: string): number {
  const v = costs.bySymbol.get(baseSymbol(symbol));
  const bps = v ? v.buyBps + v.sellBps : costs.medianBps * 2;
  return Math.min(0.03, Math.max(0.0005, bps / 10_000));
}

// --------------------------------------------------------------------------
// Live tracking
//
// The gate needs a per-name floor at decision time, not at fit time. These
// helpers recompute the figures from the newest fills and cache them in
// `symbol_execution_costs`, throttled so an hourly tick does not re-price the
// whole fill history on every candidate.
// --------------------------------------------------------------------------

/** Don't re-price the book more often than this unless a new fill landed. */
export const COST_REFRESH_MS = 15 * 60 * 1000;

export type LiveSymbolCost = {
  symbol: string;
  buyBps: number;
  sellBps: number;
  roundTripBps: number;
  fills: number;
  tickets: number;
  /** False when the figure is the account average standing in for a name with no fills. */
  measured: boolean;
  lastFillAt: string | null;
};

export type LiveCostSnapshot = {
  bySymbol: Map<string, LiveSymbolCost>;
  /** Account-wide round trip, the fallback floor for an unfilled name. */
  accountRoundTripBps: number;
  feeBps: number;
  slippageBps: number;
  fills: number;
  invoicedFills: number;
  /** Rate the broker actually invoiced, per pound dealt; null with no notes in. */
  invoicedChargeBps: number | null;
  /** Share of dealt notional covered by real contract notes (0-1). */
  invoicedNotionalShare: number;
  computedAt: string;

};

function snapshotFrom(costs: CostModel): LiveCostSnapshot {
  const bySymbol = new Map<string, LiveSymbolCost>();
  for (const [symbol, v] of costs.bySymbol) {
    bySymbol.set(symbol, {
      symbol,
      buyBps: v.buyBps,
      sellBps: v.sellBps,
      roundTripBps: v.buyBps + v.sellBps,
      fills: v.fills,
      tickets: v.tickets,
      measured: v.fills > 0,
      lastFillAt: v.lastFillAt,
    });
  }
  return {
    bySymbol,
    accountRoundTripBps: costs.medianBps * 2,
    feeBps: costs.feeBps,
    slippageBps: costs.slippageBps,
    fills: costs.fills,
    invoicedFills: costs.invoicedFills,
    computedAt: new Date().toISOString(),
  };
}

/** Portfolios belonging to a user — the fill scope for their cost model. */
async function portfolioIdsFor(userId: string): Promise<string[]> {
  const { data } = await supabaseAdmin.from("portfolios").select("id").eq("user_id", userId);
  return (data ?? []).map((r) => String(r.id));
}

/**
 * Recompute per-symbol costs from fills and persist them. Skipped when the
 * cached rows are fresher than `COST_REFRESH_MS` and no fill has landed since
 * they were written — the figures only move when a new ticket prints or the
 * tape re-prices an existing one.
 */
export async function refreshSymbolExecutionCosts(args: {
  userId: string;
  portfolioIds?: string[];
  force?: boolean;
}): Promise<{ refreshed: boolean; symbols: number; snapshot: LiveCostSnapshot | null }> {
  const ids = args.portfolioIds?.length ? args.portfolioIds : await portfolioIdsFor(args.userId);
  if (ids.length === 0) return { refreshed: false, symbols: 0, snapshot: null };

  if (!args.force) {
    const [{ data: cached }, { data: newest }] = await Promise.all([
      supabaseAdmin
        .from("symbol_execution_costs")
        .select("computed_at")
        .eq("user_id", args.userId)
        .order("computed_at", { ascending: false })
        .limit(1),
      supabaseAdmin
        .from("live_fills")
        .select("filled_at")
        .in("portfolio_id", ids)
        .order("filled_at", { ascending: false })
        .limit(1),
    ]);
    const at = cached?.[0]?.computed_at ? Date.parse(String(cached[0].computed_at)) : 0;
    const fillAt = newest?.[0]?.filled_at ? Date.parse(String(newest[0].filled_at)) : 0;
    const fresh = at > 0 && Date.now() - at < COST_REFRESH_MS && fillAt <= at;
    if (fresh) return { refreshed: false, symbols: 0, snapshot: null };
  }

  const costs = await computeExecutionCosts(ids);
  const snapshot = snapshotFrom(costs);
  const rows = Array.from(snapshot.bySymbol.values()).map((v) => ({
    user_id: args.userId,
    symbol: v.symbol,
    symbol_key: v.symbol,
    buy_bps: v.buyBps,
    sell_bps: v.sellBps,
    round_trip_bps: v.roundTripBps,
    fee_bps: costs.feeBps,
    slippage_bps: costs.slippageBps,
    tickets: v.tickets,
    fills: v.fills,
    invoiced_fills: costs.bySymbol.get(v.symbol)?.invoicedFills ?? 0,
    measured: v.measured,
    first_fill_at: costs.bySymbol.get(v.symbol)?.firstFillAt
      ? `${costs.bySymbol.get(v.symbol)!.firstFillAt}T00:00:00Z`
      : null,
    last_fill_at: v.lastFillAt ? `${v.lastFillAt}T00:00:00Z` : null,
    computed_at: snapshot.computedAt,
  }));
  if (rows.length > 0) {
    const { error } = await supabaseAdmin
      .from("symbol_execution_costs")
      .upsert(rows, { onConflict: "user_id,symbol_key" });
    if (error) return { refreshed: false, symbols: 0, snapshot };
  }
  return { refreshed: true, symbols: rows.length, snapshot };
}

/** The stored per-symbol costs, keyed by base symbol. */
export async function loadSymbolExecutionCosts(
  userId: string,
): Promise<Map<string, LiveSymbolCost>> {
  const out = new Map<string, LiveSymbolCost>();
  const { data } = await supabaseAdmin
    .from("symbol_execution_costs")
    .select("symbol, symbol_key, buy_bps, sell_bps, round_trip_bps, fills, tickets, measured, last_fill_at")
    .eq("user_id", userId);
  for (const r of data ?? []) {
    out.set(String(r.symbol_key), {
      symbol: String(r.symbol),
      buyBps: Number(r.buy_bps) || 0,
      sellBps: Number(r.sell_bps) || 0,
      roundTripBps: Number(r.round_trip_bps) || 0,
      fills: Number(r.fills) || 0,
      tickets: Number(r.tickets) || 0,
      measured: Boolean(r.measured),
      lastFillAt: r.last_fill_at ? String(r.last_fill_at) : null,
    });
  }
  return out;
}

/**
 * The round-trip floor to apply to one candidate: its own measured cost when
 * this account has actually dealt the name, else the account-wide figure.
 */
export function symbolRoundTripFloor(
  symbol: string,
  bySymbol: Map<string, LiveSymbolCost> | null | undefined,
  accountFallbackBps: number | null | undefined,
): number | null {
  const own = bySymbol?.get(baseSymbol(symbol));
  if (own && own.measured && own.roundTripBps > 0) return own.roundTripBps;
  const acct = Number(accountFallbackBps);
  return Number.isFinite(acct) && acct > 0 ? acct : null;
}
