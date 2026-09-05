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
 *     round-trip dealing cost this account actually paid on the name (measured
 *     from `live_fills` fees), divided by the risk the name was carrying at the
 *     time. So the model learns "what pays after my costs, per unit of risk",
 *     which is the only return this book can bank.
 *
 *  3. WEIGHT. Days where real money went into the name — and days on the live
 *     book rather than a paper one — carry more weight in the fit than days the
 *     engine merely looked at the symbol.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { priceSymbolVariants } from "../price-symbol";
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
type PriceSeries = { dates: string[]; closes: number[] };

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
  const rowsBySymbol = new Map<string, Array<{ d: string; c: number }>>();

  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    let page = 0;
    // Supabase caps rows per request; page until a short page comes back.
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from("price_cache")
        .select("symbol, price_date, close")
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
        const row = { d: r.price_date as string, c: close };
        if (arr) arr.push(row);
        else rowsBySymbol.set(engine, [row]);
      }
      if ((data?.length ?? 0) < 1000) break;
      page++;
    }
  }

  for (const [symbol, rows] of rowsBySymbol) {
    rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    // De-duplicate variants landing on the same date (keep the first seen).
    const dates: string[] = [];
    const closes: number[] = [];
    for (const r of rows) {
      if (dates[dates.length - 1] === r.d) continue;
      dates.push(r.d);
      closes.push(r.c);
    }
    out.set(symbol, { dates, closes });
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
// --------------------------------------------------------------------------

type CostModel = { bySymbol: Map<string, number>; medianBps: number; calibrated: number };

async function loadCostModel(portfolioIds: string[]): Promise<CostModel> {
  const bySymbol = new Map<string, number>();
  const agg = new Map<string, { fee: number; notional: number }>();

  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from("live_fills")
      .select("symbol, quantity, fill_price, fee")
      .in("portfolio_id", portfolioIds)
      .range(page * 1000, page * 1000 + 999);
    if (error) break; // costs are a refinement, never a reason to fail the fit
    for (const r of data ?? []) {
      const qty = Math.abs(Number(r.quantity) || 0);
      const px = Number(r.fill_price) || 0;
      const fee = Math.abs(Number(r.fee) || 0);
      const notional = qty * px;
      if (!(notional > 0)) continue;
      const key = baseSymbol(String(r.symbol ?? ""));
      const cur = agg.get(key) ?? { fee: 0, notional: 0 };
      cur.fee += fee;
      cur.notional += notional;
      agg.set(key, cur);
    }
    if ((data?.length ?? 0) < 1000) break;
  }

  const perSymbolBps: number[] = [];
  for (const [sym, v] of agg) {
    if (v.notional <= 0) continue;
    const bps = (v.fee / v.notional) * 10_000;
    if (!Number.isFinite(bps) || bps <= 0 || bps > 400) continue;
    bySymbol.set(sym, bps);
    perSymbolBps.push(bps);
  }
  perSymbolBps.sort((a, b) => a - b);
  const medianBps = perSymbolBps.length
    ? perSymbolBps[Math.floor(perSymbolBps.length / 2)]!
    : DEFAULT_ONE_WAY_COST_BPS;

  return { bySymbol, medianBps, calibrated: bySymbol.size };
}

function roundTripCostFrac(costs: CostModel, symbol: string): number {
  const oneWay = costs.bySymbol.get(baseSymbol(symbol)) ?? costs.medianBps;
  return Math.min(0.02, Math.max(0.0005, (oneWay * 2) / 10_000));
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
    meanWeight: 0, tradesScanned: 0,
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

  const symbols = Array.from(new Set(Array.from(byKey.values()).map((v) => v.symbol)));
  const prices = await loadPriceSeries(symbols, firstDate);

  const samples: Sample[] = [];
  let skippedNoForwardPrice = 0;
  let tradedSamples = 0;
  let heldSamples = 0;
  let weightSum = 0;

  for (const c of byKey.values()) {
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
    meanWeight: samples.length ? Math.round((weightSum / samples.length) * 100) / 100 : 0,
    tradesScanned: trades.length,
  };
}

export { FEATURE_KEYS };
