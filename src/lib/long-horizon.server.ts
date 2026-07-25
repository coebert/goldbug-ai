// Long-horizon rule-based backtester.
// Purpose: simulate 10-50 years of trading using the SAME technical signals
// (SMA20/50/200, RSI14, momentum, volatility) and portfolio risk config as
// the AI engine, but WITHOUT per-day LLM calls (would be prohibitively slow
// and costly). Runs monthly rebalancing to top-scoring candidates with
// asset-class caps, stop-loss / take-profit, and cash floor from risk_config.
//
// Also computes benchmark curves (SPY buy&hold, 60/40 SPY+AGG, Gold, and an
// equal-weight universe portfolio) and slices metrics per historical regime.

import { getDailyCandlesRange, sma, rsi, pctChange, dailyVolatility } from "./market-data.server";
import { riskProfile, parseRiskConfig, effectiveCashFloorPct, type RiskConfig } from "./universe.server";
import type { Database } from "@/integrations/supabase/types";

type AssetClass = Database["public"]["Enums"]["asset_class"];

// Curated long-history universe. All tickers with >=10y of Yahoo daily data.
// Newer tickers (BTC 2010, TLT 2002, GLD 2004…) simply enter the sim once
// data starts.
export const LONG_HORIZON_UNIVERSE: Array<{
  symbol: string;
  name: string;
  asset_class: AssetClass;
}> = [
  { symbol: "SPY", name: "S&P 500 ETF", asset_class: "etf" },
  { symbol: "QQQ", name: "Nasdaq 100 ETF", asset_class: "etf" },
  { symbol: "IWM", name: "Russell 2000 ETF", asset_class: "etf" },
  { symbol: "EFA", name: "Developed ex-US ETF", asset_class: "etf" },
  { symbol: "EEM", name: "Emerging Markets ETF", asset_class: "etf" },
  { symbol: "TLT", name: "20+Y Treasuries", asset_class: "etf" },
  { symbol: "AGG", name: "US Aggregate Bonds", asset_class: "etf" },
  { symbol: "GLD", name: "Gold ETF", asset_class: "commodity" },
  { symbol: "USO", name: "Crude Oil ETF", asset_class: "commodity" },
  { symbol: "AAPL", name: "Apple", asset_class: "stock" },
  { symbol: "MSFT", name: "Microsoft", asset_class: "stock" },
  { symbol: "JNJ", name: "Johnson & Johnson", asset_class: "stock" },
  { symbol: "JPM", name: "JPMorgan", asset_class: "stock" },
  { symbol: "XOM", name: "ExxonMobil", asset_class: "stock" },
  { symbol: "BTC-USD", name: "Bitcoin", asset_class: "crypto" },
];

// Historical regime windows (from HISTORICAL_PLAYBOOK). Overlap allowed;
// slices are computed independently per regime.
export const REGIMES: Array<{
  key: string;
  name: string;
  from: string;
  to: string;
  kind: "bull" | "bear" | "shock" | "recovery" | "sideways";
}> = [
  { key: "vol1979", name: "Volcker inflation fight", from: "1979-01-01", to: "1982-12-31", kind: "bear" },
  { key: "bull80s", name: "Reagan disinflation bull", from: "1982-08-01", to: "1987-08-31", kind: "bull" },
  { key: "bm1987", name: "Black Monday & aftermath", from: "1987-10-01", to: "1988-06-30", kind: "shock" },
  { key: "iraq1990", name: "Iraq/Kuwait oil shock", from: "1990-07-01", to: "1991-03-31", kind: "shock" },
  { key: "bull90s", name: "1990s disinflation bull", from: "1991-04-01", to: "2000-03-31", kind: "bull" },
  { key: "asia1997", name: "Asia / LTCM / Russia", from: "1997-07-01", to: "1998-12-31", kind: "shock" },
  { key: "dotcom", name: "Dot-com bust", from: "2000-03-01", to: "2002-10-31", kind: "bear" },
  { key: "gfc", name: "Global Financial Crisis", from: "2007-10-01", to: "2009-03-31", kind: "bear" },
  { key: "qeBull", name: "Post-GFC QE bull", from: "2009-04-01", to: "2020-02-28", kind: "bull" },
  { key: "covid", name: "Covid crash & recovery", from: "2020-02-15", to: "2020-12-31", kind: "shock" },
  { key: "stag2022", name: "2022 stag-inflation", from: "2022-01-01", to: "2022-12-31", kind: "bear" },
  { key: "ai2023", name: "AI mega-cap rally", from: "2023-01-01", to: "2024-12-31", kind: "bull" },
];

export type Metrics = {
  startValue: number;
  endValue: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  volatilityPct: number;
  days: number;
};

export type CurvePoint = { date: string; value: number };
export type SeriesResult = {
  key: string;
  name: string;
  color: string;
  curve: CurvePoint[];
  metrics: Metrics;
};

export type ExecutionCosts = {
  commission_bps: number;   // per side, in basis points of notional
  slippage_bps: number;     // per side, price impact in basis points
  min_trade_value: number;  // trades below this notional are skipped
};

export type LongHorizonResult = {
  from: string;
  to: string;
  starting_cash: number;
  currency: string;
  rebalance: "monthly" | "quarterly";
  execution: ExecutionCosts;
  series: SeriesResult[];
  regimes: Array<{
    key: string;
    name: string;
    from: string;
    to: string;
    kind: string;
    rows: Array<{ seriesKey: string; name: string; metrics: Metrics }>;
  }>;
  tradeCount: number;
  skippedSmallTrades: number;
  totalCostsPaid: number;
};

function computeMetrics(curve: CurvePoint[]): Metrics {
  if (curve.length < 2) {
    const v = curve[0]?.value ?? 0;
    return { startValue: v, endValue: v, totalReturnPct: 0, cagrPct: 0, maxDrawdownPct: 0, sharpe: 0, volatilityPct: 0, days: curve.length };
  }
  const startValue = curve[0].value;
  const endValue = curve[curve.length - 1].value;
  const totalReturnPct = ((endValue - startValue) / startValue) * 100;
  const years = Math.max(0.01, (new Date(curve[curve.length - 1].date).getTime() - new Date(curve[0].date).getTime()) / (365.25 * 86400000));
  const cagrPct = (Math.pow(endValue / startValue, 1 / years) - 1) * 100;
  let peak = startValue;
  let maxDD = 0;
  const rets: number[] = [];
  for (let i = 0; i < curve.length; i++) {
    const v = curve[i].value;
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDD) maxDD = dd;
    if (i > 0) {
      const prev = curve[i - 1].value;
      if (prev > 0) rets.push((v - prev) / prev);
    }
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  return {
    startValue,
    endValue,
    totalReturnPct,
    cagrPct,
    maxDrawdownPct: maxDD * 100,
    sharpe,
    volatilityPct: std * Math.sqrt(252) * 100,
    days: curve.length,
  };
}

function sliceCurve(curve: CurvePoint[], from: string, to: string): CurvePoint[] {
  return curve.filter((p) => p.date >= from && p.date <= to);
}

// Score a symbol on a given day using signals aligned with the AI engine.
function scoreSymbol(closes: number[]): { score: number; reason: string } | null {
  if (closes.length < 60) return null;
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = closes.length >= 200 ? sma(closes, 200) : null;
  const r = rsi(closes, 14);
  const m1 = pctChange(closes, 21); // ~1 month
  const m6 = closes.length > 126 ? pctChange(closes, 126) : null;
  const price = closes[closes.length - 1];
  if (s20 == null || s50 == null || r == null || m1 == null) return null;

  let score = 0;
  const reasons: string[] = [];
  if (price > s20) { score += 1; reasons.push("px>SMA20"); }
  if (s20 > s50) { score += 1; reasons.push("SMA20>50"); }
  if (s200 != null && s50 > s200) { score += 1; reasons.push("SMA50>200 (golden)"); }
  if (r < 30) { score += 2; reasons.push(`RSI ${r.toFixed(0)} oversold`); }
  else if (r > 75) { score -= 2; reasons.push(`RSI ${r.toFixed(0)} overbought`); }
  else if (r > 55 && r < 70) { score += 1; reasons.push(`RSI ${r.toFixed(0)} healthy`); }
  if (m1 > 0.02) { score += 1; reasons.push(`+${(m1 * 100).toFixed(1)}% 1m`); }
  if (m1 < -0.05) { score -= 1; reasons.push(`${(m1 * 100).toFixed(1)}% 1m`); }
  if (m6 != null && m6 > 0.10) { score += 1; reasons.push(`+${(m6 * 100).toFixed(0)}% 6m`); }
  return { score, reason: reasons.join(", ") };
}

type SymbolData = {
  symbol: string;
  asset_class: AssetClass;
  byDate: Map<string, number>; // date -> close
  dates: string[]; // sorted
};

async function loadUniverseData(
  universe: Array<{ symbol: string; asset_class: AssetClass }>,
  from: string,
  to: string,
): Promise<SymbolData[]> {
  // Fetch with a warm-up of 400 calendar days for SMA200.
  const warmup = new Date(new Date(from).getTime() - 400 * 86400000).toISOString().slice(0, 10);
  const results = await Promise.all(
    universe.map(async (u) => {
      const candles = await getDailyCandlesRange(u.symbol, warmup, to);
      const byDate = new Map<string, number>();
      for (const c of candles) byDate.set(c.date, c.close);
      const dates = candles.map((c) => c.date).sort();
      return { symbol: u.symbol, asset_class: u.asset_class, byDate, dates };
    }),
  );
  return results;
}

function buildTradingDays(seriesList: SymbolData[], from: string, to: string): string[] {
  const set = new Set<string>();
  for (const s of seriesList) {
    for (const d of s.dates) {
      if (d >= from && d <= to) set.add(d);
    }
  }
  return Array.from(set).sort();
}

function isRebalanceDay(date: string, prevDate: string | null, freq: "monthly" | "quarterly"): boolean {
  if (!prevDate) return true;
  const cur = new Date(date);
  const prev = new Date(prevDate);
  if (freq === "monthly") return cur.getUTCMonth() !== prev.getUTCMonth() || cur.getUTCFullYear() !== prev.getUTCFullYear();
  // quarterly: month changes into Jan/Apr/Jul/Oct
  const curQ = Math.floor(cur.getUTCMonth() / 3);
  const prevQ = Math.floor(prev.getUTCMonth() / 3);
  return curQ !== prevQ || cur.getUTCFullYear() !== prev.getUTCFullYear();
}

// Build a rolling closes[] up to `date` for a symbol, drawing from cache map.
// Returns last ~250 trading days ending on or before `date`.
function closesUpTo(sym: SymbolData, date: string, lookback = 260): number[] {
  const out: number[] = [];
  // sym.dates is sorted; binary search for the last index <= date
  let lo = 0, hi = sym.dates.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sym.dates[mid] <= date) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return out;
  const start = Math.max(0, idx - lookback + 1);
  for (let i = start; i <= idx; i++) {
    const v = sym.byDate.get(sym.dates[i]);
    if (v != null) out.push(v);
  }
  return out;
}

export async function runLongHorizonBacktest(opts: {
  from: string;
  to: string;
  startingCash: number;
  currency: string;
  riskLevel: Database["public"]["Enums"]["risk_level"];
  riskConfig: unknown;
  universe: Array<{ symbol: string; asset_class: AssetClass }>;
  rebalance?: "monthly" | "quarterly";
  topK?: number;
  execution?: Partial<ExecutionCosts>;
}): Promise<LongHorizonResult> {
  const rebalance = opts.rebalance ?? "monthly";
  const topK = opts.topK ?? 6;
  const rp = riskProfile(opts.riskLevel);
  const rc: RiskConfig = parseRiskConfig(opts.riskConfig);
  const execution: ExecutionCosts = {
    commission_bps: Math.max(0, opts.execution?.commission_bps ?? 5),
    slippage_bps: Math.max(0, opts.execution?.slippage_bps ?? 10),
    min_trade_value: Math.max(0, opts.execution?.min_trade_value ?? 25),
  };
  const commRate = execution.commission_bps / 10_000;
  const slipRate = execution.slippage_bps / 10_000;

  const [uniData, benchData] = await Promise.all([
    loadUniverseData(opts.universe, opts.from, opts.to),
    loadUniverseData(
      [
        { symbol: "SPY", asset_class: "etf" as AssetClass },
        { symbol: "AGG", asset_class: "etf" as AssetClass },
        { symbol: "GLD", asset_class: "commodity" as AssetClass },
      ],
      opts.from,
      opts.to,
    ),
  ]);

  const days = buildTradingDays(uniData, opts.from, opts.to);
  if (days.length === 0) {
    return {
      from: opts.from,
      to: opts.to,
      starting_cash: opts.startingCash,
      currency: opts.currency,
      rebalance,
      execution,
      series: [],
      regimes: [],
      tradeCount: 0,
      skippedSmallTrades: 0,
      totalCostsPaid: 0,
    };
  }

  // ---- Strategy sim ----
  let cash = opts.startingCash;
  const holdings = new Map<string, { qty: number; avgCost: number }>();
  const strategyCurve: CurvePoint[] = [];
  let tradeCount = 0;
  let skippedSmallTrades = 0;
  let totalCostsPaid = 0;
  let prevDay: string | null = null;

  const priceOn = (sym: SymbolData, date: string): number | null => {
    // Fall back to most recent price <= date if the symbol didn't trade that day.
    if (sym.byDate.has(date)) return sym.byDate.get(date)!;
    // binary search
    let lo = 0, hi = sym.dates.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sym.dates[mid] <= date) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx >= 0 ? sym.byDate.get(sym.dates[idx]) ?? null : null;
  };

  const valuePortfolio = (date: string): number => {
    let v = cash;
    for (const [sym, h] of holdings) {
      const s = uniData.find((u) => u.symbol === sym);
      const p = s ? priceOn(s, date) : null;
      if (p != null) v += h.qty * p;
    }
    return v;
  };

  // Execute a sell of `qty` shares at raw price `p`. Applies slippage (fill
  // below quote) and commission (deducted from proceeds). Returns proceeds
  // net of costs, or null if trade notional falls below min_trade_value.
  const sellShares = (sym: string, qty: number, p: number): number | null => {
    const gross = qty * p;
    if (gross < execution.min_trade_value) { skippedSmallTrades++; return null; }
    const fill = p * (1 - slipRate);
    const proceedsGross = qty * fill;
    const commission = proceedsGross * commRate;
    const net = proceedsGross - commission;
    cash += net;
    totalCostsPaid += (gross - net); // slippage + commission vs mid
    tradeCount++;
    return net;
  };

  // Execute a buy of shares given a `spend` budget in cash at raw price `p`.
  // Returns shares acquired (avg cost includes slippage + commission), or null
  // if trade notional falls below min_trade_value.
  const buyShares = (sym: string, spend: number, p: number): { qty: number; effCost: number } | null => {
    if (spend < execution.min_trade_value) { skippedSmallTrades++; return null; }
    const fill = p * (1 + slipRate);
    const perShareCost = fill * (1 + commRate); // commission baked into per-share cost
    const qty = spend / perShareCost;
    cash -= spend;
    totalCostsPaid += spend - qty * p; // portion of spend that is cost vs mid
    tradeCount++;
    return { qty, effCost: perShareCost };
  };

  for (const day of days) {
    // 1. Apply stop-loss / take-profit exits every day
    for (const [sym, h] of Array.from(holdings)) {
      const s = uniData.find((u) => u.symbol === sym);
      if (!s) continue;
      const p = priceOn(s, day);
      if (p == null || h.avgCost <= 0) continue;
      const pnl = (p - h.avgCost) / h.avgCost;
      if ((rc.stop_loss_pct > 0 && pnl <= -rc.stop_loss_pct) ||
          (rc.take_profit_pct > 0 && pnl >= rc.take_profit_pct)) {
        const ok = sellShares(sym, h.qty, p);
        if (ok != null) holdings.delete(sym);
      }
    }

    // 2. Rebalance on cadence
    if (isRebalanceDay(day, prevDay, rebalance)) {
      // Score all symbols with sufficient history
      const scored: Array<{ sym: SymbolData; score: number; price: number; vol: number | null }> = [];
      for (const s of uniData) {
        const closes = closesUpTo(s, day);
        if (closes.length < 60) continue;
        const sc = scoreSymbol(closes);
        if (!sc || sc.score <= 0) continue;
        const p = closes[closes.length - 1];
        const vol = dailyVolatility(closes, 20);
        scored.push({ sym: s, score: sc.score, price: p, vol });
      }
      scored.sort((a, b) => b.score - a.score);
      const picks = scored.slice(0, topK);

      const totalValue = valuePortfolio(day);
      const cashFloor = totalValue * rp.cashFloorPct;
      const investable = Math.max(0, totalValue - cashFloor);

      // Base target weight = equal-weight across picks, capped by per-symbol,
      // per-class limits, and optional vol targeting.
      const perSymCap = rc.per_symbol_limit_pct ?? rp.maxPositionPct;
      const rawWeights = new Map<string, number>();
      const baseW = picks.length > 0 ? Math.min(perSymCap, 1 / picks.length) : 0;
      for (const p of picks) {
        let w = baseW;
        if (rc.volatility_sizing && p.vol && p.vol > 0) {
          const scaled = Math.min(baseW, rc.vol_target_pct / p.vol);
          w = Math.max(0.01, scaled);
        }
        rawWeights.set(p.sym.symbol, Math.min(w, perSymCap));
      }
      const classTotals: Partial<Record<AssetClass, number>> = {};
      for (const p of picks) {
        const w = rawWeights.get(p.sym.symbol) ?? 0;
        classTotals[p.sym.asset_class] = (classTotals[p.sym.asset_class] ?? 0) + w;
      }
      for (const [cls, tot] of Object.entries(classTotals) as [AssetClass, number][]) {
        const cap = rc.asset_class_limits[cls];
        if (cap != null && tot > cap && tot > 0) {
          const scale = cap / tot;
          for (const p of picks) {
            if (p.sym.asset_class === cls) {
              rawWeights.set(p.sym.symbol, (rawWeights.get(p.sym.symbol) ?? 0) * scale);
            }
          }
        }
      }
      const sumW = Array.from(rawWeights.values()).reduce((a, b) => a + b, 0);
      if (sumW > 1) {
        for (const [k, v] of rawWeights) rawWeights.set(k, v / sumW);
      }

      // Sell anything not in picks
      const wanted = new Set(picks.map((p) => p.sym.symbol));
      for (const [sym, h] of Array.from(holdings)) {
        if (!wanted.has(sym)) {
          const s = uniData.find((u) => u.symbol === sym);
          const p = s ? priceOn(s, day) : null;
          if (p != null) {
            const ok = sellShares(sym, h.qty, p);
            if (ok != null) holdings.delete(sym);
          }
        }
      }

      // Rebalance to target
      const totalValue2 = valuePortfolio(day);
      for (const p of picks) {
        const targetValue = investable * (rawWeights.get(p.sym.symbol) ?? 0) * (totalValue2 / Math.max(totalValue, 1e-9));
        const cur = holdings.get(p.sym.symbol);
        const curValue = (cur?.qty ?? 0) * p.price;
        const diff = targetValue - curValue;
        // ignore drift smaller than either 0.5% of portfolio or the min trade size
        if (Math.abs(diff) < Math.max(totalValue2 * 0.005, execution.min_trade_value)) continue;
        if (diff > 0) {
          const spend = Math.min(diff, cash - cashFloor);
          if (spend <= 0) continue;
          const res = buyShares(p.sym.symbol, spend, p.price);
          if (!res) continue;
          const newQty = (cur?.qty ?? 0) + res.qty;
          const newCost = ((cur?.qty ?? 0) * (cur?.avgCost ?? 0) + res.qty * res.effCost) / newQty;
          holdings.set(p.sym.symbol, { qty: newQty, avgCost: newCost });
        } else if (cur) {
          const sellQty = Math.min(cur.qty, (-diff) / p.price);
          const ok = sellShares(p.sym.symbol, sellQty, p.price);
          if (ok == null) continue;
          const remaining = cur.qty - sellQty;
          if (remaining <= 1e-9) holdings.delete(p.sym.symbol);
          else holdings.set(p.sym.symbol, { qty: remaining, avgCost: cur.avgCost });
        }
      }
    }

    strategyCurve.push({ date: day, value: valuePortfolio(day) });
    prevDay = day;
  }

  // ---- Benchmarks ----
  const buildBuyHoldCurve = (
    weightedSymbols: Array<{ sym: SymbolData; weight: number }>,
  ): CurvePoint[] => {
    // Determine start day where at least one component has data.
    const startDay = days.find((d) => weightedSymbols.some((ws) => ws.sym.byDate.has(d) || priceOn(ws.sym, d) != null))
      ?? days[0];
    // Compute how many units per symbol we'd hold if we invested startingCash at startDay by weight.
    // Apply one-time entry costs (slippage + commission) so buy-and-hold benchmarks
    // are compared on the same execution basis as the active strategy.
    const units = new Map<string, number>();
    for (const ws of weightedSymbols) {
      const p0 = priceOn(ws.sym, startDay);
      if (p0 && p0 > 0) {
        const entryFill = p0 * (1 + slipRate) * (1 + commRate);
        units.set(ws.sym.symbol, (opts.startingCash * ws.weight) / entryFill);
      }
    }
    const curve: CurvePoint[] = [];
    for (const d of days) {
      if (d < startDay) {
        curve.push({ date: d, value: opts.startingCash });
        continue;
      }
      let v = 0;
      for (const ws of weightedSymbols) {
        const q = units.get(ws.sym.symbol);
        const p = priceOn(ws.sym, d);
        if (q && p) v += q * p;
      }
      curve.push({ date: d, value: v || opts.startingCash });
    }
    return curve;
  };

  const spy = benchData.find((s) => s.symbol === "SPY")!;
  const agg = benchData.find((s) => s.symbol === "AGG")!;
  const gld = benchData.find((s) => s.symbol === "GLD")!;

  const spyCurve = buildBuyHoldCurve([{ sym: spy, weight: 1 }]);
  const sixtyForty = buildBuyHoldCurve([
    { sym: spy, weight: 0.6 },
    { sym: agg, weight: 0.4 },
  ]);
  const goldCurve = buildBuyHoldCurve([{ sym: gld, weight: 1 }]);
  const equalWeight = buildBuyHoldCurve(
    uniData.map((s) => ({ sym: s, weight: 1 / uniData.length })),
  );

  const series: SeriesResult[] = [
    { key: "aegis", name: "Aegis strategy", color: "#22d3ee", curve: strategyCurve, metrics: computeMetrics(strategyCurve) },
    { key: "spy", name: "S&P 500 (SPY)", color: "#a78bfa", curve: spyCurve, metrics: computeMetrics(spyCurve) },
    { key: "6040", name: "60/40 (SPY/AGG)", color: "#facc15", curve: sixtyForty, metrics: computeMetrics(sixtyForty) },
    { key: "gold", name: "Gold (GLD)", color: "#fb923c", curve: goldCurve, metrics: computeMetrics(goldCurve) },
    { key: "eq", name: "Equal-weight universe", color: "#4ade80", curve: equalWeight, metrics: computeMetrics(equalWeight) },
  ];

  // ---- Regime slices ----
  const regimes = REGIMES
    .filter((r) => r.from <= opts.to && r.to >= opts.from)
    .map((reg) => {
      const from = reg.from > opts.from ? reg.from : opts.from;
      const to = reg.to < opts.to ? reg.to : opts.to;
      const rows = series
        .map((s) => ({
          seriesKey: s.key,
          name: s.name,
          metrics: computeMetrics(sliceCurve(s.curve, from, to)),
        }))
        .filter((r) => r.metrics.days > 5);
      return { key: reg.key, name: reg.name, from, to, kind: reg.kind, rows };
    })
    .filter((r) => r.rows.length > 0);

  return {
    from: opts.from,
    to: opts.to,
    starting_cash: opts.startingCash,
    currency: opts.currency,
    rebalance,
    execution,
    series,
    regimes,
    tradeCount,
    skippedSmallTrades,
    totalCostsPaid,
  };
}
