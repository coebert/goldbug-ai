/**
 * Builds the training set for the learned decision model out of the account's
 * own recorded history — trades included, not just prices.
 *
 * Three things make this portfolio-specific rather than a generic signal study:
 *
 *  1. FEATURES. Every row in `decisions` carries `raw.signals` — the exact
 *     per-symbol snapshot the engine handed the AI that day. On top of that we
 *     rebuild the book as it stood on the day (position size, unrealised P&L,
 *     holding age, cash share, drawdown from peak, decayed memory of realised
 *     losses on the name) from `trades` and `equity_snapshots`, and feed that
 *     in as features too. No look-ahead: only trades dated strictly before the
 *     decision date are applied.
 *
 *  2. LABEL. Not the raw forward return, but the forward return net of the
 *     round-trip dealing cost this account actually paid on that name, on that
 *     side — the invoiced broker charges on the contract note plus the gap
 *     between the day's printed close and the price the fill came back at,
 *     measured per symbol from `live_fills` — divided by the risk the name was
 *     carrying at the time. So the model learns "what pays after my costs, per
 *     unit of risk", which is the only return this book can bank.
 *
 *  3. WEIGHT. Days where real money went into the name — and days on the live
 *     book rather than a paper one — carry more weight in the fit than days the
 *     engine merely looked at the symbol.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Candle } from "../market-data.server";
import { priceSymbolVariants } from "../price-symbol";
import { estimateTradeCosts } from "../trade-viability-gate";
import { inferSaxoCurrency } from "../saxo-fees";
import {
  extractFeatureVector,
  FEATURE_KEYS,
  NEUTRAL_PF,
  NEUTRAL_MX,
  NEUTRAL_SX,
  regimeRiskOn,
  withContext,
  withPf,
  type AnyRow,
  type MxContext,
  type PfContext,
  type SxContext,
} from "./features";
import { symbolSector } from "../sector-rotation.server";
import type { Sample } from "./fit";

export type LabelMode = "risk_net" | "price";

export type DatasetOptions = {
  userId: string;
  /** Forward-return horizon in trading days. */
  horizonDays?: number;
  /** Only use decisions from real-money books when true. */
  realMoneyOnly?: boolean;
  /** `risk_net` (default) = cost- and risk-adjusted; `price` = raw forward return. */
  labelMode?: LabelMode;
  /**
   * How many years of bar history to rebuild behind the first recorded
   * decision. 0 = recorded decisions only (the old behaviour).
   */
  historyYears?: number;
  /** Sampling stride, in trading days, for the rebuilt history. */
  historyStrideDays?: number;
};

export type DatasetResult = {
  samples: Sample[];
  dates: string[];
  symbols: string[];
  decisionsScanned: number;
  snapshotsScanned: number;
  skippedNoForwardPrice: number;
  horizonDays: number;
  from: string | null;
  to: string | null;
  labelMode: LabelMode;
  /** Observations on a day this account actually traded the name. */
  tradedSamples: number;
  /** Observations where the name was already held. */
  heldSamples: number;
  /** Median round-trip dealing cost applied to the label, in bps. */
  roundTripCostBps: number;
  /** Symbols with their own measured cost (rest use the account median). */
  costCalibratedSymbols: number;
  /** Median invoiced charge per one-way ticket, in bps of notional. */
  costFeeBps: number;
  /** Median gap between the day's close and the price this account was filled at. */
  costSlippageBps: number;
  /** Broker fills the cost model was measured from. */
  costFills: number;
  /** Of those, fills carrying itemised broker charges rather than a modelled fee. */
  costInvoicedFills: number;
  meanWeight: number;
  tradesScanned: number;
  /** Rows rebuilt from bars before the first recorded decision. */
  historySamples: number;
  /** Earliest date the rebuilt history reaches. */
  historyFrom: string | null;
};

const REAL_MONEY_MODES = new Set(["live_prod", "live_sim"]);
const LOSS_MEMORY_HALFLIFE_DAYS = 30;
const DEFAULT_ONE_WAY_COST_BPS = 15;
const DEFAULT_HISTORY_YEARS = 10;
const DEFAULT_HISTORY_STRIDE = 5;
/**
 * Weight of a rebuilt pre-engine row relative to a real recorded decision day.
 * Low on purpose: these rows have no news, no book state and no macro context,
 * so they inform the price/trend relationships without overruling how this
 * account has actually behaved.
 */
const HISTORY_SAMPLE_WEIGHT = 0.35;


/** Close prices for one symbol, ordered by date, keyed by the engine symbol. */
type PriceSeries = { dates: string[]; closes: number[]; candles: Candle[] };

function baseSymbol(symbol: string): string {
  return (symbol.split(":")[0] ?? symbol).trim().toUpperCase();
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

async function loadPriceSeries(symbols: string[], from: string): Promise<Map<string, PriceSeries>> {
  const out = new Map<string, PriceSeries>();
  // Query in chunks: the variant list can be several times the symbol count.
  const wanted = new Map<string, string>(); // cache symbol -> engine symbol
  for (const s of symbols) for (const v of priceSymbolVariants(s)) if (!wanted.has(v)) wanted.set(v, s);

  const keys = Array.from(wanted.keys());
  const CHUNK = 120;
  const rowsBySymbol = new Map<string, Candle[]>();

  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    let page = 0;
    // Supabase caps rows per request; page until a short page comes back.
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from("price_cache")
        .select("symbol, price_date, open, high, low, close, volume")
        .in("symbol", slice)
        .gte("price_date", from)
        .order("price_date", { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) throw new Error(`price_cache read failed: ${error.message}`);
      for (const r of data ?? []) {
        const engine = wanted.get(r.symbol as string);
        if (!engine) continue;
        const close = Number(r.close);
        if (!Number.isFinite(close) || close <= 0) continue;
        const arr = rowsBySymbol.get(engine);
        const row: Candle = {
          date: r.price_date as string,
          open: Number(r.open) || close,
          high: Number(r.high) || close,
          low: Number(r.low) || close,
          close,
          volume: Number(r.volume) || 0,
        };
        if (arr) arr.push(row);
        else rowsBySymbol.set(engine, [row]);
      }
      if ((data?.length ?? 0) < 1000) break;
      page++;
    }
  }

  for (const [symbol, rows] of rowsBySymbol) {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // De-duplicate variants landing on the same date (keep the first seen).
    const dates: string[] = [];
    const closes: number[] = [];
    const candles: Candle[] = [];
    for (const r of rows) {
      if (dates[dates.length - 1] === r.date) continue;
      dates.push(r.date);
      closes.push(r.close);
      candles.push(r);
    }
    out.set(symbol, { dates, closes, candles });
  }
  return out;
}

/** Index of the first bar on or after `date`. */
function indexOnOrAfter(series: PriceSeries, date: string): number {
  let lo = 0;
  let hi = series.dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid]! >= date) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
}

/** Realised daily volatility over the `lookback` bars ending at `i0`, scaled to the horizon. */
function horizonRisk(series: PriceSeries, i0: number, horizonDays: number, lookback = 20): number {
  const start = Math.max(1, i0 - lookback);
  const rets: number[] = [];
  for (let i = start; i <= i0; i++) {
    const a = series.closes[i - 1]!;
    const b = series.closes[i]!;
    if (a > 0 && b > 0) {
      const r = Math.log(b / a);
      if (Number.isFinite(r) && Math.abs(r) < 0.5) rets.push(r);
    }
  }
  if (rets.length < 5) return 0.04;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) * (b - m), 0) / (rets.length - 1));
  const scaled = sd * Math.sqrt(horizonDays);
  return Math.min(0.30, Math.max(0.01, scaled));
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

type SideCost = { feeBps: number; slipBps: number; fills: number };
type SymbolCost = { buyBps: number; sellBps: number; fills: number };

type CostModel = {
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

async function loadCostModel(portfolioIds: string[]): Promise<CostModel> {
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
  const allCharge: number[] = [];
  const allSlip: number[] = [];
  let invoicedFills = 0;
  let slippageFills = 0;

  for (const f of fills) {
    const key = `${f.symbol}|${f.side}`;
    const cur = bySide.get(key) ?? { fills: 0, chargeW: 0, chargeBps: 0, slips: [] };
    cur.fills++;

    const rawClose = f.date ? closeByKey.get(`${f.symbol}|${f.date}`) : undefined;
    const close = rawClose === undefined ? null : alignUnits(f.price, rawClose);

    // Charges as a rate. Invoiced when the contract note is in; otherwise the
    // same tiered commission / stamp duty / levy schedule the live gate prices
    // every ticket with — applied to the real fill size, so a small ticket
    // carries the fixed floor it genuinely pays.
    const notionalNative = f.quantity * f.price;
    let chargeBps: number;
    if (f.invoicedCharge !== null) {
      invoicedFills++;
      chargeBps = (f.invoicedCharge / notionalNative) * 10_000;
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
    }
    if (Number.isFinite(chargeBps) && chargeBps >= 0 && chargeBps <= MAX_ONE_WAY_BPS) {
      cur.chargeW += notionalNative;
      cur.chargeBps += chargeBps * notionalNative;
      allCharge.push(chargeBps);
    }

    if (close !== null) {
      const signed = f.side === "buy" ? f.price - close : close - f.price;
      const bps = (signed / close) * 10_000;
      if (Number.isFinite(bps) && Math.abs(bps) <= MAX_ONE_WAY_BPS) {
        cur.slips.push(bps);
        allSlip.push(bps);
        slippageFills++;
      }
    }
    bySide.set(key, cur);
  }

  const accountCharge = median(allCharge) ?? DEFAULT_ONE_WAY_COST_BPS;
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
    bySymbol.set(sym, {
      buyBps: sideCost(sym, "buy"),
      sellBps: sideCost(sym, "sell"),
      fills: buys + sells,
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
  };
}

/** Round trip = what this account pays getting in, plus what it pays getting out. */
function roundTripCostFrac(costs: CostModel, symbol: string): number {
  const v = costs.bySymbol.get(baseSymbol(symbol));
  const bps = v ? v.buyBps + v.sellBps : costs.medianBps * 2;
  return Math.min(0.03, Math.max(0.0005, bps / 10_000));
}


// --------------------------------------------------------------------------
// Rebuilding the book as it stood on each decision day
// --------------------------------------------------------------------------

type TradeRow = {
  portfolio_id: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  value: number;
  trade_date: string;
};

type Position = { qty: number; avgCost: number; openedAt: string };
type LossEvent = { date: string; amount: number };

type BookState = {
  positions: Map<string, Position>;
  losses: Map<string, LossEvent[]>;
  cursor: number;
};

function applyTrade(state: BookState, t: TradeRow) {
  const key = baseSymbol(t.symbol);
  const qty = Math.abs(Number(t.quantity) || 0);
  const price = Number(t.price) || 0;
  if (!(qty > 0) || !(price > 0)) return;

  const pos = state.positions.get(key);
  if (t.side === "buy") {
    if (pos && pos.qty > 0) {
      const total = pos.qty + qty;
      pos.avgCost = (pos.avgCost * pos.qty + price * qty) / total;
      pos.qty = total;
    } else {
      state.positions.set(key, { qty, avgCost: price, openedAt: t.trade_date });
    }
    return;
  }

  // Sell: bank the realised P&L, remember it if it was a loss.
  if (!pos || pos.qty <= 0) return;
  const sold = Math.min(qty, pos.qty);
  const realised = (price - pos.avgCost) * sold;
  if (realised < 0) {
    const arr = state.losses.get(key) ?? [];
    arr.push({ date: t.trade_date, amount: realised });
    state.losses.set(key, arr);
  }
  pos.qty -= sold;
  if (pos.qty <= 1e-9) state.positions.delete(key);
}

function lossMemory(state: BookState, symbol: string, date: string, equity: number): number {
  const events = state.losses.get(baseSymbol(symbol));
  if (!events || !(equity > 0)) return 0;
  let total = 0;
  for (const e of events) {
    const age = dayDiff(date, e.date);
    if (age < 0 || age > 180) continue;
    total += e.amount * Math.pow(0.5, age / LOSS_MEMORY_HALFLIFE_DAYS);
  }
  return Math.max(-1, total / equity);
}

// --------------------------------------------------------------------------

type DecRow = { portfolio_id: string; run_date: string; raw: unknown };

function modePriority(mode: string): number {
  if (mode === "live_prod") return 3;
  if (mode === "live_sim") return 2;
  if (mode === "paper") return 1;
  return 0;
}

export async function buildDataset(opts: DatasetOptions): Promise<DatasetResult> {
  const horizonDays = Math.max(1, Math.min(20, opts.horizonDays ?? 5));
  const labelMode: LabelMode = opts.labelMode ?? "risk_net";

  const { data: portfolios, error: pErr } = await supabaseAdmin
    .from("portfolios")
    .select("id, mode")
    .eq("user_id", opts.userId);
  if (pErr) throw new Error(`portfolios read failed: ${pErr.message}`);

  const modeById = new Map<string, string>();
  for (const p of portfolios ?? []) modeById.set(p.id as string, (p.mode as string) ?? "");

  const ids = Array.from(modeById.entries())
    .filter(([, mode]) => !opts.realMoneyOnly || REAL_MONEY_MODES.has(mode))
    .map(([id]) => id);

  const empty: DatasetResult = {
    samples: [], dates: [], symbols: [], decisionsScanned: 0, snapshotsScanned: 0,
    skippedNoForwardPrice: 0, horizonDays, from: null, to: null, labelMode,
    tradedSamples: 0, heldSamples: 0, roundTripCostBps: 0, costCalibratedSymbols: 0,
    costFeeBps: 0, costSlippageBps: 0, costFills: 0, costInvoicedFills: 0,
    meanWeight: 0, tradesScanned: 0, historySamples: 0, historyFrom: null,
  };
  if (ids.length === 0) return empty;

  // --- decisions ----------------------------------------------------------
  const decisions: DecRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from("decisions")
      .select("portfolio_id, run_date, raw")
      .in("portfolio_id", ids)
      .order("run_date", { ascending: true })
      .range(page * 500, page * 500 + 499);
    if (error) throw new Error(`decisions read failed: ${error.message}`);
    decisions.push(...((data ?? []) as unknown as DecRow[]));
    if ((data?.length ?? 0) < 500) break;
  }
  if (decisions.length === 0) return empty;

  const firstDate = decisions[0]!.run_date;

  // --- trades (position history) -----------------------------------------
  const trades: TradeRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from("trades")
      .select("portfolio_id, symbol, side, quantity, price, value, trade_date")
      .in("portfolio_id", ids)
      .order("trade_date", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`trades read failed: ${error.message}`);
    trades.push(...((data ?? []) as unknown as TradeRow[]));
    if ((data?.length ?? 0) < 1000) break;
  }

  const tradesByPortfolio = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const arr = tradesByPortfolio.get(t.portfolio_id);
    if (arr) arr.push(t);
    else tradesByPortfolio.set(t.portfolio_id, [t]);
  }
  // Notional traded per (portfolio, date, symbol) — drives the sample weight.
  const tradedNotional = new Map<string, number>();
  for (const t of trades) {
    const key = `${t.portfolio_id}|${t.trade_date}|${baseSymbol(t.symbol)}`;
    const v = Math.abs(Number(t.value) || Math.abs(Number(t.quantity) || 0) * (Number(t.price) || 0));
    tradedNotional.set(key, (tradedNotional.get(key) ?? 0) + v);
  }

  // --- equity / cash by day ----------------------------------------------
  type EqRow = { portfolio_id: string; snapshot_date: string; cash: number; total_value: number };
  const equity: EqRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from("equity_snapshots")
      .select("portfolio_id, snapshot_date, cash, total_value")
      .in("portfolio_id", ids)
      .order("snapshot_date", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) break;
    equity.push(...((data ?? []) as unknown as EqRow[]));
    if ((data?.length ?? 0) < 1000) break;
  }
  const equityByPortfolio = new Map<string, EqRow[]>();
  for (const e of equity) {
    const arr = equityByPortfolio.get(e.portfolio_id);
    if (arr) arr.push(e);
    else equityByPortfolio.set(e.portfolio_id, [e]);
  }
  // Running peak per portfolio, for the drawdown feature.
  const peakByPortfolioDate = new Map<string, number>();
  for (const [pid, rows] of equityByPortfolio) {
    let peak = 0;
    for (const r of rows) {
      const tv = Number(r.total_value) || 0;
      if (tv > peak) peak = tv;
      peakByPortfolioDate.set(`${pid}|${r.snapshot_date}`, peak);
    }
  }

  function equityOn(pid: string, date: string): { cash: number; total: number; peak: number } | null {
    const rows = equityByPortfolio.get(pid);
    if (!rows || rows.length === 0) return null;
    let lo = 0;
    let hi = rows.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]!.snapshot_date <= date) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (ans < 0) return null;
    const r = rows[ans]!;
    const total = Number(r.total_value) || 0;
    if (!(total > 0)) return null;
    return {
      cash: Number(r.cash) || 0,
      total,
      peak: peakByPortfolioDate.get(`${pid}|${r.snapshot_date}`) ?? total,
    };
  }

  const costs = await loadCostModel(ids);

  // --- market backdrop (macro) and sector standings, by day ---------------
  const macroByDate: Array<{ date: string; mx: MxContext }> = [];
  {
    const { data } = await supabaseAdmin
      .from("market_regimes")
      .select("as_of, regime, signals")
      .gte("as_of", firstDate)
      .order("as_of", { ascending: true });
    for (const r of data ?? []) {
      const s = (r.signals ?? {}) as Record<string, unknown>;
      const n = (k: string): number | null => {
        const v = Number(s[k]);
        return Number.isFinite(v) ? v : null;
      };
      macroByDate.push({
        date: r.as_of as string,
        mx: {
          vix_level: n("vix_level"),
          spy_drawdown_pct: n("spy_drawdown_pct"),
          spy_price: n("spy_price"),
          spy_sma200: n("spy_sma200"),
          spy_return_30d: n("spy_return_30d"),
          tlt_return_30d: n("tlt_return_30d"),
          gld_return_30d: n("gld_return_30d"),
          risk_on: regimeRiskOn(r.regime as string | null),
        },
      });
    }
  }
  function macroOn(date: string): MxContext {
    let lo = 0;
    let hi = macroByDate.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (macroByDate[mid]!.date <= date) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans < 0 ? NEUTRAL_MX : macroByDate[ans]!.mx;
  }

  // sector standings: date -> sector -> momentum/rank
  type SectorStanding = { momentum_30d: number | null; momentum_90d: number | null; rank_norm: number | null };
  const sectorDates: string[] = [];
  const sectorByDate = new Map<string, Map<string, SectorStanding>>();
  {
    const { data } = await supabaseAdmin
      .from("sector_scores")
      .select("as_of, sector, momentum_30d, momentum_90d, rank")
      .gte("as_of", firstDate)
      .order("as_of", { ascending: true });
    const ranksPerDate = new Map<string, number>();
    for (const r of data ?? []) {
      const d = r.as_of as string;
      ranksPerDate.set(d, Math.max(ranksPerDate.get(d) ?? 0, Number(r.rank) || 0));
    }
    for (const r of data ?? []) {
      const d = r.as_of as string;
      let m = sectorByDate.get(d);
      if (!m) {
        m = new Map();
        sectorByDate.set(d, m);
        sectorDates.push(d);
      }
      const maxRank = ranksPerDate.get(d) ?? 0;
      const rank = Number(r.rank);
      m.set(String(r.sector), {
        momentum_30d: Number.isFinite(Number(r.momentum_30d)) ? Number(r.momentum_30d) : null,
        momentum_90d: Number.isFinite(Number(r.momentum_90d)) ? Number(r.momentum_90d) : null,
        rank_norm:
          Number.isFinite(rank) && maxRank > 1 ? 1 - (2 * (rank - 1)) / (maxRank - 1) : null,
      });
    }
  }
  function sectorStandingsOn(date: string): Map<string, SectorStanding> {
    let lo = 0;
    let hi = sectorDates.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sectorDates[mid]! <= date) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans < 0 ? new Map() : sectorByDate.get(sectorDates[ans]!) ?? new Map();
  }

  // --- walk each portfolio's decisions forward, rebuilding the book -------
  type Candidate = {
    date: string;
    symbol: string;
    row: AnyRow;
    priority: number;
    weight: number;
    traded: boolean;
    held: boolean;
    /** True for rows rebuilt from bars before the first recorded decision. */
    history?: boolean;
  };
  const byKey = new Map<string, Candidate>();
  let snapshotsScanned = 0;

  const decisionsByPortfolio = new Map<string, DecRow[]>();
  for (const d of decisions) {
    const arr = decisionsByPortfolio.get(d.portfolio_id);
    if (arr) arr.push(d);
    else decisionsByPortfolio.set(d.portfolio_id, [d]);
  }

  for (const [pid, rows] of decisionsByPortfolio) {
    const mode = modeById.get(pid) ?? "";
    const priority = modePriority(mode);
    const bookWeight = REAL_MONEY_MODES.has(mode) ? 2 : mode === "paper" ? 1.2 : 1;
    const pTrades = (tradesByPortfolio.get(pid) ?? []).slice().sort((a, b) =>
      a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0,
    );
    const state: BookState = { positions: new Map(), losses: new Map(), cursor: 0 };

    for (const d of rows) {
      // Only trades settled strictly before today — no look-ahead.
      while (state.cursor < pTrades.length && pTrades[state.cursor]!.trade_date < d.run_date) {
        applyTrade(state, pTrades[state.cursor]!);
        state.cursor++;
      }

      const eq = equityOn(pid, d.run_date);
      const total = eq?.total ?? 0;
      const cashWeight = eq && total > 0 ? Math.max(0, Math.min(1, eq.cash / total)) : 0;
      const drawdown = eq && eq.peak > 0 ? Math.min(0, total / eq.peak - 1) : 0;

      const raw = d.raw as { signals?: unknown } | null;
      const signals = Array.isArray(raw?.signals) ? (raw!.signals as AnyRow[]) : [];

      const mx = macroOn(d.run_date);
      const standings = sectorStandingsOn(d.run_date);
      // Sector exposure of the book that day, priced off the same snapshot.
      const priceBySymbol = new Map<string, number>();
      for (const s of signals) {
        const sym = typeof s?.["symbol"] === "string" ? baseSymbol(s["symbol"] as string) : null;
        const px = Number(s?.["price"]) || 0;
        if (sym && px > 0) priceBySymbol.set(sym, px);
      }
      const sectorValue = new Map<string, number>();
      for (const [sym, pos] of state.positions) {
        const px = priceBySymbol.get(sym) ?? 0;
        const sector = symbolSector(sym);
        if (!sector || !(px > 0) || !(pos.qty > 0)) continue;
        sectorValue.set(sector, (sectorValue.get(sector) ?? 0) + pos.qty * px);
      }
      for (const s of signals) {
        const symbol = typeof s?.["symbol"] === "string" ? (s["symbol"] as string) : null;
        if (!symbol) continue;
        snapshotsScanned++;

        const key = `${d.run_date}|${symbol}`;
        const existing = byKey.get(key);
        if (existing && existing.priority >= priority) continue;

        const base = baseSymbol(symbol);
        const pos = state.positions.get(base);
        const price = Number(s["price"]) || 0;
        const held = !!pos && pos.qty > 0;
        const positionWeight = held && total > 0 && price > 0 ? (pos!.qty * price) / total : 0;
        const unrealised = held && pos!.avgCost > 0 && price > 0 ? price / pos!.avgCost - 1 : 0;
        const holdDays = held ? Math.max(0, dayDiff(d.run_date, pos!.openedAt)) : 0;

        const pf: PfContext = {
          ...NEUTRAL_PF,
          position_weight: Math.min(1, positionWeight),
          unrealised_pct: Math.max(-0.9, Math.min(3, unrealised)),
          hold_days: holdDays,
          loss_memory: lossMemory(state, base, d.run_date, total),
          cash_weight: cashWeight,
          book_drawdown: Math.max(-0.9, drawdown),
        };

        const sector = symbolSector(base);
        const standing = sector ? standings.get(sector) : undefined;
        const sx: SxContext = {
          ...NEUTRAL_SX,
          momentum_30d: standing?.momentum_30d ?? null,
          momentum_90d: standing?.momentum_90d ?? null,
          rank_norm: standing?.rank_norm ?? null,
          book_weight: sector && total > 0 ? Math.min(1, (sectorValue.get(sector) ?? 0) / total) : 0,
        };

        const notional = tradedNotional.get(`${pid}|${d.run_date}|${base}`) ?? 0;
        const traded = notional > 0;
        let weight = bookWeight;
        if (traded && total > 0) weight *= 1 + 2 * Math.min(1, notional / (0.05 * total));
        else if (traded) weight *= 2;
        if (held) weight *= 1.25;

        byKey.set(key, {
          date: d.run_date,
          symbol,
          row: withContext(withPf(s, pf), { date: d.run_date, sx, mx }),
          priority,
          weight: Math.min(8, weight),
          traded,
          held,
        });
      }
    }
  }

  // Symbols worth carrying long history for: everything the engine has looked
  // at, plus everything this account has actually traded.
  const symbols = Array.from(
    new Set([
      ...Array.from(byKey.values()).map((v) => v.symbol),
      ...trades.map((t) => t.symbol),
    ]),
  );

  const historyYears = Math.max(0, Math.min(25, opts.historyYears ?? DEFAULT_HISTORY_YEARS));
  const historyFrom =
    historyYears > 0
      ? new Date(Date.parse(firstDate) - historyYears * 365.25 * 86_400_000)
          .toISOString()
          .slice(0, 10)
      : firstDate;

  const prices = await loadPriceSeries(symbols, historyFrom);

  // Rebuild the same technical snapshot on every Nth bar before the engine's
  // first recorded decision, so the fit sees years of behaviour, not weeks.
  const historyCandidates: Candidate[] = [];
  if (historyYears > 0) {
    const candlesBySymbol = new Map<string, Candle[]>();
    for (const [symbol, series] of prices) {
      if (series.candles.length >= 120) candlesBySymbol.set(symbol, series.candles);
    }
    const { buildHistoricalCandidates } = await import("./history-extension.server");
    for (const h of buildHistoricalCandidates({
      candlesBySymbol,
      from: historyFrom,
      before: firstDate,
      strideDays: Math.max(1, opts.historyStrideDays ?? DEFAULT_HISTORY_STRIDE),
    })) {
      historyCandidates.push({
        date: h.date,
        symbol: h.symbol,
        row: h.row,
        priority: 0,
        weight: HISTORY_SAMPLE_WEIGHT,
        traded: false,
        held: false,
        history: true,
      });
    }
  }

  const samples: Sample[] = [];
  let skippedNoForwardPrice = 0;
  let tradedSamples = 0;
  let heldSamples = 0;
  let weightSum = 0;
  let historySamples = 0;

  for (const c of [...byKey.values(), ...historyCandidates]) {
    const series = prices.get(c.symbol);
    if (!series) {
      skippedNoForwardPrice++;
      continue;
    }

    const i0 = indexOnOrAfter(series, c.date);
    const i1 = i0 < 0 ? -1 : i0 + horizonDays;
    if (i0 < 0 || i1 >= series.dates.length) {
      skippedNoForwardPrice++;
      continue;
    }
    const p0 = series.closes[i0]!;
    const p1 = series.closes[i1]!;
    if (!(p0 > 0) || !(p1 > 0)) {
      skippedNoForwardPrice++;
      continue;
    }
    const gross = p1 / p0 - 1;
    // Guard against unit switches / bad cache rows producing absurd returns.
    if (!Number.isFinite(gross) || Math.abs(gross) > 1) {
      skippedNoForwardPrice++;
      continue;
    }

    let y = gross;
    if (labelMode === "risk_net") {
      const net = gross - roundTripCostFrac(costs, c.symbol);
      const risk = horizonRisk(series, i0, horizonDays);
      y = Math.max(-5, Math.min(5, net / risk));
    }

    if (c.traded) tradedSamples++;
    if (c.held) heldSamples++;
    if (c.history) historySamples++;
    weightSum += c.weight;
    samples.push({ date: c.date, symbol: c.symbol, x: extractFeatureVector(c.row), y, w: c.weight });
  }

  const usedDates = Array.from(new Set(samples.map((s) => s.date))).sort();
  return {
    samples,
    dates: usedDates,
    symbols,
    decisionsScanned: decisions.length,
    snapshotsScanned,
    skippedNoForwardPrice,
    horizonDays,
    from: usedDates[0] ?? null,
    to: usedDates[usedDates.length - 1] ?? null,
    labelMode,
    tradedSamples,
    heldSamples,
    roundTripCostBps: Math.round(costs.medianBps * 2 * 10) / 10,
    costCalibratedSymbols: costs.calibrated,
    costFeeBps: costs.feeBps,
    costSlippageBps: costs.slippageBps,
    costFills: costs.fills,
    costInvoicedFills: costs.invoicedFills,
    meanWeight: samples.length ? Math.round((weightSum / samples.length) * 100) / 100 : 0,
    tradesScanned: trades.length,
    historySamples,
    historyFrom: historyYears > 0 ? historyFrom : null,
  };
}

export { FEATURE_KEYS };
