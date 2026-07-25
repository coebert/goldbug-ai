// Historical replay backtest for commodity buys.
//
// Replays the last N years of daily bars for representative gold/silver/oil/
// gas/copper ETCs and, on each day the price cross generates a "buy" signal,
// runs the exact same guardrails the live trading engine uses to decide
// whether that buy would be accepted or rejected. Reports rejection counts
// per reason and per commodity group so users can judge how often their
// current risk config would have blocked new commodity exposure.
//
// Pure engine: takes prefetched candles + risk config, returns a report.
// Kept intentionally free of Supabase / network calls so it can be unit
// tested and reused by other backtest surfaces.

import { sma, rsi, dailyVolatility, type Candle } from "./market-data.server";
import { computeCommodityTradeLiquidity } from "./commodity-liquidity-metrics";
import { classifyCommoditySymbol, type CommodityGroup } from "./commodity-groups";
import { riskProfile, type RiskConfig } from "./universe.server";
import type { Database } from "@/integrations/supabase/types";

export type CommodityBacktestSymbol = {
  symbol: string;
  group: CommodityGroup;
  candles: Candle[]; // ascending by date, warmup + window
};

export type CommodityBacktestOpts = {
  from: string; // inclusive YYYY-MM-DD
  to: string;   // inclusive
  startingCash: number;
  riskLevel: Database["public"]["Enums"]["risk_level"];
  riskConfig: RiskConfig;
  symbols: CommodityBacktestSymbol[];
  // Optional override for the minimum trade notional. Falls back to
  // riskConfig.execution_params.min_trade_value, then a sensible default.
  minTradeValue?: number;
};

export type CommodityRejectionReason =
  | "illiquid_adv"
  | "excess_atr"
  | "min_notional"
  | "per_symbol_cap"
  | "group_cap"
  | "asset_class_cap"
  | "cash_floor";

export type CommodityBacktestReport = {
  from: string;
  to: string;
  daysReplayed: number;
  totalSignalDays: number;
  totalProposals: number;
  accepted: number;
  rejected: number;
  acceptanceRate: number; // 0..1
  rejectionCounts: Record<CommodityRejectionReason, number>;
  bySymbol: Array<{
    symbol: string;
    group: CommodityGroup;
    signalDays: number;
    proposals: number;
    accepted: number;
    rejected: number;
    rejectionCounts: Record<CommodityRejectionReason, number>;
  }>;
  byGroup: Array<{
    group: CommodityGroup;
    proposals: number;
    accepted: number;
    rejected: number;
    rejectionCounts: Record<CommodityRejectionReason, number>;
  }>;
  // First 100 rejection examples for the UI drill-down table.
  sampleRejections: Array<{
    date: string;
    symbol: string;
    group: CommodityGroup;
    reason: CommodityRejectionReason;
    detail: string;
  }>;
};

const REASONS: CommodityRejectionReason[] = [
  "illiquid_adv",
  "excess_atr",
  "min_notional",
  "per_symbol_cap",
  "group_cap",
  "asset_class_cap",
  "cash_floor",
];

function emptyCounts(): Record<CommodityRejectionReason, number> {
  return {
    illiquid_adv: 0,
    excess_atr: 0,
    min_notional: 0,
    per_symbol_cap: 0,
    group_cap: 0,
    asset_class_cap: 0,
    cash_floor: 0,
  };
}

// Simple trend/momentum "would-propose-a-buy" signal on close-of-day.
// Same shape as the AI engine's bullish inputs: price above 20/50-day SMA,
// RSI in a healthy 30–70 range, and 21-day momentum positive.
function isBuySignal(closes: number[]): boolean {
  if (closes.length < 50) return false;
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const r = rsi(closes, 14);
  const price = closes[closes.length - 1];
  const then = closes[closes.length - 22] ?? closes[0];
  const mom = then > 0 ? (price - then) / then : 0;
  if (s20 == null || s50 == null || r == null) return false;
  return price > s20 && s20 > s50 && r >= 30 && r <= 70 && mom > 0;
}

// Average daily volume in native currency over the last N sessions.
function avgDollarVolume(candles: Candle[], period = 20): number {
  const slice = candles.slice(-period);
  if (slice.length === 0) return 0;
  let sum = 0;
  for (const c of slice) sum += (c.close || 0) * (c.volume || 0);
  return sum / slice.length;
}

// True Range → ATR% (ATR / last close) over `period` sessions.
function atrPct(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (!cur || !prev) continue;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trs.push(tr);
  }
  if (trs.length === 0) return null;
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const last = candles[candles.length - 1].close;
  return last > 0 ? atr / last : null;
}

export function runCommodityRejectionBacktest(
  opts: CommodityBacktestOpts,
): CommodityBacktestReport {
  const rp = riskProfile(opts.riskLevel);
  const rc = opts.riskConfig;
  const minTradeValue = Math.max(
    0,
    opts.minTradeValue ??
      rc.execution_params?.min_trade_value ??
      25,
  );

  const perSymCap = rc.per_symbol_limit_pct ?? rp.maxPositionPct;
  const commodityClassCap = rc.asset_class_limits.commodity ?? 1;
  const cashFloorPct = rp.cashFloorPct;
  const minAdvUsd = rc.commodity_min_adv_usd;
  const maxAtr = rc.commodity_max_atr_pct;

  // Standing (unrealised) exposure per symbol/group as a fraction of NAV.
  // Advances every accepted proposal; we keep NAV fixed at startingCash for
  // the "would this have been rejected?" question — we're not simulating
  // full trading PnL here.
  const symbolExposure = new Map<string, number>();
  const groupExposure = new Map<CommodityGroup, number>();
  let commodityExposure = 0;
  let cash = opts.startingCash;
  const nav = opts.startingCash;

  const bySymbolAgg = new Map<
    string,
    {
      group: CommodityGroup;
      signalDays: number;
      proposals: number;
      accepted: number;
      rejected: number;
      counts: Record<CommodityRejectionReason, number>;
    }
  >();
  for (const s of opts.symbols) {
    bySymbolAgg.set(s.symbol, {
      group: s.group,
      signalDays: 0,
      proposals: 0,
      accepted: 0,
      rejected: 0,
      counts: emptyCounts(),
    });
  }

  const totals = emptyCounts();
  const sampleRejections: CommodityBacktestReport["sampleRejections"] = [];

  // Build the union of trading days in the [from,to] window.
  const dateSet = new Set<string>();
  for (const s of opts.symbols) {
    for (const c of s.candles) {
      if (c.date >= opts.from && c.date <= opts.to) dateSet.add(c.date);
    }
  }
  const days = Array.from(dateSet).sort();

  let totalProposals = 0;
  let totalSignalDays = 0;
  let accepted = 0;
  let rejected = 0;

  // Cache: for each symbol, closes[] and candles[] up to (and including) each
  // date. Precompute an index-by-date once.
  const indexByDate = new Map<string, Map<string, number>>();
  for (const s of opts.symbols) {
    const m = new Map<string, number>();
    for (let i = 0; i < s.candles.length; i++) m.set(s.candles[i].date, i);
    indexByDate.set(s.symbol, m);
  }

  for (const day of days) {
    for (const s of opts.symbols) {
      const idxMap = indexByDate.get(s.symbol);
      const idx = idxMap?.get(day);
      if (idx == null || idx < 50) continue; // needs warmup
      const window = s.candles.slice(0, idx + 1);
      const closes = window.map((c) => c.close);
      if (!isBuySignal(closes)) continue;
      totalSignalDays++;
      const agg = bySymbolAgg.get(s.symbol)!;
      agg.signalDays++;

      const price = closes[closes.length - 1];
      const adv = avgDollarVolume(window, 20);
      const atr = atrPct(window, 14);
      const vol = dailyVolatility(closes, 20);

      // Compute a target spend using vol-targeting when enabled, capped by
      // the per-symbol NAV limit.
      let targetPct = perSymCap;
      if (rc.volatility_sizing && vol && vol > 0) {
        targetPct = Math.min(perSymCap, rc.vol_target_pct / vol);
      }
      targetPct = Math.max(0.005, targetPct);
      const requestedSpend = nav * targetPct;

      // Feed the same liquidity metric used at live execution.
      computeCommodityTradeLiquidity({
        requestedSpend,
        price,
        atrPct: atr,
        adv20d: window[window.length - 1].volume,
        liquidityCappedSpend: null,
      });

      totalProposals++;
      agg.proposals++;

      // Evaluate guardrails in priority order. First failure wins so the
      // sample-rejection table shows the primary reason a live executor
      // would surface.
      let reason: CommodityRejectionReason | null = null;
      let detail = "";

      if (minAdvUsd > 0 && adv < minAdvUsd) {
        reason = "illiquid_adv";
        detail = `ADV ${adv.toFixed(0)} < min ${minAdvUsd}`;
      } else if (maxAtr > 0 && atr != null && atr > maxAtr) {
        reason = "excess_atr";
        detail = `ATR ${(atr * 100).toFixed(2)}% > cap ${(maxAtr * 100).toFixed(2)}%`;
      } else if (requestedSpend < minTradeValue) {
        reason = "min_notional";
        detail = `spend ${requestedSpend.toFixed(2)} < min ${minTradeValue}`;
      } else if ((symbolExposure.get(s.symbol) ?? 0) + targetPct > perSymCap + 1e-9) {
        reason = "per_symbol_cap";
        detail = `symbol exposure ${(((symbolExposure.get(s.symbol) ?? 0) + targetPct) * 100).toFixed(1)}% > cap ${(perSymCap * 100).toFixed(1)}%`;
      } else {
        const groupCap = rc.commodity_group_limits[s.group];
        const groupNow = groupExposure.get(s.group) ?? 0;
        if (groupCap != null && groupNow + targetPct > groupCap + 1e-9) {
          reason = "group_cap";
          detail = `${s.group} exposure ${((groupNow + targetPct) * 100).toFixed(1)}% > cap ${(groupCap * 100).toFixed(1)}%`;
        } else if (commodityExposure + targetPct > commodityClassCap + 1e-9) {
          reason = "asset_class_cap";
          detail = `commodity class ${((commodityExposure + targetPct) * 100).toFixed(1)}% > cap ${(commodityClassCap * 100).toFixed(1)}%`;
        } else if (cash - requestedSpend < nav * cashFloorPct - 1e-6) {
          reason = "cash_floor";
          detail = `cash after buy ${(cash - requestedSpend).toFixed(0)} < floor ${(nav * cashFloorPct).toFixed(0)}`;
        }
      }

      if (reason) {
        rejected++;
        agg.rejected++;
        totals[reason]++;
        agg.counts[reason]++;
        if (sampleRejections.length < 100) {
          sampleRejections.push({ date: day, symbol: s.symbol, group: s.group, reason, detail });
        }
      } else {
        accepted++;
        agg.accepted++;
        symbolExposure.set(s.symbol, (symbolExposure.get(s.symbol) ?? 0) + targetPct);
        groupExposure.set(s.group, (groupExposure.get(s.group) ?? 0) + targetPct);
        commodityExposure += targetPct;
        cash -= requestedSpend;
      }
    }
  }

  const bySymbol = Array.from(bySymbolAgg.entries()).map(([symbol, v]) => ({
    symbol,
    group: v.group,
    signalDays: v.signalDays,
    proposals: v.proposals,
    accepted: v.accepted,
    rejected: v.rejected,
    rejectionCounts: v.counts,
  }));

  const groupMap = new Map<
    CommodityGroup,
    { proposals: number; accepted: number; rejected: number; counts: Record<CommodityRejectionReason, number> }
  >();
  for (const row of bySymbol) {
    const g = groupMap.get(row.group) ?? {
      proposals: 0,
      accepted: 0,
      rejected: 0,
      counts: emptyCounts(),
    };
    g.proposals += row.proposals;
    g.accepted += row.accepted;
    g.rejected += row.rejected;
    for (const r of REASONS) g.counts[r] += row.rejectionCounts[r];
    groupMap.set(row.group, g);
  }
  const byGroup = Array.from(groupMap.entries()).map(([group, v]) => ({
    group,
    proposals: v.proposals,
    accepted: v.accepted,
    rejected: v.rejected,
    rejectionCounts: v.counts,
  }));

  return {
    from: opts.from,
    to: opts.to,
    daysReplayed: days.length,
    totalSignalDays,
    totalProposals,
    accepted,
    rejected,
    acceptanceRate: totalProposals > 0 ? accepted / totalProposals : 0,
    rejectionCounts: totals,
    bySymbol,
    byGroup,
    sampleRejections,
  };
}

// Default replay universe: one representative liquid ETC per group covered
// by the request (gold, silver, oil, gas, copper).
export const COMMODITY_BACKTEST_SYMBOLS: Array<{ symbol: string; group: CommodityGroup }> = [
  { symbol: "SGLN.L", group: "Gold" },
  { symbol: "SSLN.L", group: "Silver" },
  { symbol: "CRUD.L", group: "Oil" },
  { symbol: "NGAS.L", group: "Gas" },
  { symbol: "COPA.L", group: "Copper" },
];

// Assert the mapping stays consistent with the shared classifier, so a
// future edit to COMMODITY_SYMBOL_MAP can't silently mis-label a bar.
for (const s of COMMODITY_BACKTEST_SYMBOLS) {
  const cls = classifyCommoditySymbol(s.symbol);
  if (cls && cls !== s.group) {
    throw new Error(
      `commodity-backtest symbol/group mismatch for ${s.symbol}: expected ${s.group}, classifier says ${cls}`,
    );
  }
}
