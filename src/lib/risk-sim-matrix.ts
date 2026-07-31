// Risk-level simulation matrix.
//
// Replays a deterministic multi-asset price tape through the real heuristic
// rule-set (`buildHeuristicBuys` / `buildHeuristicSells`) at each risk level
// and horizon, then scores the resulting equity curves with the real metrics
// module. Pure and seeded — same inputs always produce the same table.

import { runBacktest, type BacktestBar } from "@/lib/backtest-runner";
import {
  buildHeuristicBuys,
  buildHeuristicSells,
  type HeuristicFeature,
} from "@/lib/heuristic-decision";
import {
  computeMaxDrawdown,
  computeSharpe,
  computeAnnualisedVolPct,
  dailyReturns,
  type EquityPoint,
} from "@/lib/backtest-metrics";
import type { SimDecision } from "@/lib/broker-simulator";

export type RiskLevel = "low" | "balanced" | "high";
export const RISK_LEVELS: RiskLevel[] = ["low", "balanced", "high"];

export type AssetSpec = {
  symbol: string;
  /** Annualised drift, e.g. 0.10 = +10%/yr. */
  drift: number;
  /** Annualised volatility, e.g. 0.22 = 22%. */
  vol: number;
  start: number;
  /** Sinusoidal regime cycle length in bars (adds mean-reverting swings). */
  cycleBars: number;
  cycleAmp: number;
};

/** A broad, deliberately heterogeneous universe: mega-cap, cyclical, defensive, index, high-beta. */
export const DEFAULT_UNIVERSE: AssetSpec[] = [
  { symbol: "MEGA", drift: 0.14, vol: 0.24, start: 180, cycleBars: 55, cycleAmp: 0.05 },
  { symbol: "CYCL", drift: 0.08, vol: 0.34, start: 62, cycleBars: 34, cycleAmp: 0.09 },
  { symbol: "DEFN", drift: 0.05, vol: 0.13, start: 118, cycleBars: 90, cycleAmp: 0.02 },
  { symbol: "INDX", drift: 0.09, vol: 0.16, start: 410, cycleBars: 70, cycleAmp: 0.03 },
  { symbol: "BETA", drift: 0.18, vol: 0.48, start: 27, cycleBars: 21, cycleAmp: 0.14 },
  { symbol: "VALU", drift: 0.06, vol: 0.19, start: 84, cycleBars: 47, cycleAmp: 0.04 },
  { symbol: "GRWT", drift: 0.16, vol: 0.31, start: 240, cycleBars: 29, cycleAmp: 0.08 },
  { symbol: "COMM", drift: 0.03, vol: 0.27, start: 55, cycleBars: 40, cycleAmp: 0.11 },
];

export const HORIZONS: Array<{ label: string; bars: number }> = [
  { label: "1M", bars: 21 },
  { label: "3M", bars: 63 },
  { label: "6M", bars: 126 },
  { label: "1Y", bars: 252 },
  { label: "2Y", bars: 504 },
];

// ------------------------------------------------------------ price tape

/** Mulberry32 — small, fast, fully deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal draw from a uniform generator. */
function normal(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  const v = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function isoDate(index: number): string {
  const base = Date.UTC(2024, 0, 1);
  const d = new Date(base + index * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Seeded GBM tape with a per-asset regime cycle layered on top. */
export function buildPriceTape(
  universe: AssetSpec[],
  bars: number,
  seed: number,
): BacktestBar[] {
  const r = rng(seed);
  const px: Record<string, number> = {};
  for (const a of universe) px[a.symbol] = a.start;
  const out: BacktestBar[] = [];

  for (let i = 0; i < bars; i++) {
    const closes: Record<string, number> = {};
    for (const a of universe) {
      const dt = 1 / 252;
      const shock = normal(r) * a.vol * Math.sqrt(dt);
      const cycle = a.cycleAmp * Math.sin((2 * Math.PI * i) / a.cycleBars) * dt * 252 * 0.02;
      const step = (a.drift - 0.5 * a.vol ** 2) * dt + shock + cycle;
      px[a.symbol] = Math.max(0.5, px[a.symbol] * Math.exp(step));
      closes[a.symbol] = Math.round(px[a.symbol] * 10_000) / 10_000;
    }
    out.push({ date: isoDate(i), closes });
  }
  return out;
}

// -------------------------------------------------------------- features

function pctChange(series: number[], lookback: number): number | null {
  if (series.length <= lookback) return null;
  const prev = series[series.length - 1 - lookback];
  const last = series[series.length - 1];
  if (!(prev > 0)) return null;
  return (last - prev) / prev;
}

/** Wilder-style RSI over the last `period` closes. */
function rsi(series: number[], period = 14): number | null {
  if (series.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = series.length - period; i < series.length; i++) {
    const diff = series[i] - series[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function ema(series: number[], period: number): number | null {
  if (series.length < period) return null;
  const k = 2 / (period + 1);
  let e = series.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < series.length; i++) e = series[i] * k + e * (1 - k);
  return e;
}

/** MACD histogram proxy: (EMA12 − EMA26) − EMA9 of that spread, normalised by price. */
function macdHist(series: number[]): number | null {
  const fast = ema(series, 12);
  const slow = ema(series, 26);
  if (fast == null || slow == null) return null;
  const spread: number[] = [];
  for (let i = 26; i <= series.length; i++) {
    const f = ema(series.slice(0, i), 12);
    const s = ema(series.slice(0, i), 26);
    if (f != null && s != null) spread.push(f - s);
  }
  const signal = ema(spread, Math.min(9, spread.length)) ?? spread[spread.length - 1] ?? 0;
  const last = spread[spread.length - 1] ?? 0;
  const px = series[series.length - 1] || 1;
  return (last - signal) / px;
}

export function featuresFrom(history: Record<string, number[]>): HeuristicFeature[] {
  return Object.entries(history).map(([symbol, series]) => ({
    symbol,
    rsi14: rsi(series),
    change5d: pctChange(series, 5),
    change30d: pctChange(series, 30),
    macd_hist: macdHist(series),
    assetClass: "stock",
  }));
}

// ------------------------------------------------------------- simulation

export type SimRunMetrics = {
  riskLevel: RiskLevel;
  horizon: string;
  bars: number;
  seed: number;
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  annualisedVolPct: number;
  /** Return per unit of drawdown — the risk-adjusted headline. */
  calmar: number;
  trades: number;
  buys: number;
  sells: number;
  /** Share of round-trips (sell steps) closed at a profit. */
  winRatePct: number;
  finalCashPct: number;
  distinctSymbols: number;
};

export type SimMatrixOptions = {
  universe?: AssetSpec[];
  horizons?: Array<{ label: string; bars: number }>;
  riskLevels?: RiskLevel[];
  startingCash?: number;
  /** Seeds averaged over per cell, to avoid single-path luck. */
  seeds?: number[];
  feePerTrade?: number;
};

const DEFAULT_SEEDS = [20260731, 771, 4242, 90210, 13337];

export async function runRiskLevelSim(
  riskLevel: RiskLevel,
  bars: BacktestBar[],
  startingCash: number,
  feePerTrade: number,
): Promise<{
  equity: EquityPoint[];
  buys: number;
  sells: number;
  wins: number;
  closed: number;
  finalCash: number;
  /** Open positions at the end of the tape (symbol → quantity, avgCost). */
  finalHoldings: SimHolding[];
  /** Peak simultaneous open positions seen during the run. */
  peakOpenPositions: number;
  symbols: Set<string>;
}> {
  let buys = 0;
  let sells = 0;
  const symbols = new Set<string>();

  const result = await runBacktest(
    { cash: startingCash, holdings: [] },
    bars,
    ({ state, closes, history, barIndex }) => {
      // Warm-up: the feature set needs 30 bars of history to be meaningful.
      if (barIndex < 31) return [];
      const feats = featuresFrom(history);
      const holdings = state.holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity }));
      const decisions: SimDecision[] = [];

      for (const s of buildHeuristicSells(holdings, feats)) {
        const price = closes[s.symbol];
        if (!(price > 0) || !(s.quantity > 0)) continue;
        decisions.push({
          id: `${barIndex}-s-${s.symbol}`,
          symbol: s.symbol,
          side: "SELL",
          quantity: s.quantity,
          price,
        });
        sells++;
      }

      const heldAfterSells = new Set(
        holdings.filter((h) => !decisions.some((d) => d.symbol === h.symbol)).map((h) => h.symbol),
      );
      const cashAvail = state.cash;
      for (const b of buildHeuristicBuys(holdings, feats, { cashValue: cashAvail, riskLevel })) {
        if (heldAfterSells.has(b.symbol)) continue;
        const price = closes[b.symbol];
        if (!(price > 0)) continue;
        const qty = Math.floor((cashAvail * (b.percent / 100)) / price);
        if (qty < 1) continue;
        decisions.push({
          id: `${barIndex}-b-${b.symbol}`,
          symbol: b.symbol,
          side: "BUY",
          quantity: qty,
          price,
        });
        symbols.add(b.symbol);
        buys++;
      }
      return decisions;
    },
    { defaultFee: feePerTrade },
  );

  const equity: EquityPoint[] = result.equityCurve.map((p) => ({
    snapshot_date: p.date,
    total_value: p.totalValue,
  }));
  const sellSnaps = result.snapshots.filter((s) => s.side === "SELL");
  const wins = sellSnaps.filter((s) => s.realizedPnl > 0).length;

  return {
    equity,
    buys,
    sells,
    wins,
    closed: sellSnaps.length,
    finalCash: result.finalState.cash,
    symbols,
  };
}

function scoreRun(
  riskLevel: RiskLevel,
  horizon: string,
  bars: number,
  seed: number,
  startingCash: number,
  run: Awaited<ReturnType<typeof runRiskLevelSim>>,
): SimRunMetrics {
  const endEquity = run.equity.at(-1)?.total_value ?? startingCash;
  const rets = dailyReturns(run.equity);
  const dd = computeMaxDrawdown(run.equity);
  const totalReturn = endEquity / startingCash - 1;
  const years = bars / 252;
  const cagr = years > 0 ? (endEquity / startingCash) ** (1 / years) - 1 : 0;
  const ddAbs = Math.abs(dd.pct);

  return {
    riskLevel,
    horizon,
    bars,
    seed,
    startEquity: startingCash,
    endEquity,
    totalReturnPct: totalReturn * 100,
    cagrPct: cagr * 100,
    maxDrawdownPct: dd.pct,
    sharpe: computeSharpe(rets),
    annualisedVolPct: computeAnnualisedVolPct(rets),
    calmar: ddAbs > 1e-9 ? (cagr * 100) / ddAbs : 0,
    trades: run.buys + run.sells,
    buys: run.buys,
    sells: run.sells,
    winRatePct: run.closed > 0 ? (run.wins / run.closed) * 100 : 0,
    finalCashPct: endEquity > 0 ? (run.finalCash / endEquity) * 100 : 0,
    distinctSymbols: run.symbols.size,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Average a set of same-cell runs (one per seed) into a single row. */
export function averageRuns(runs: SimRunMetrics[]): SimRunMetrics {
  const first = runs[0];
  const pick = (f: (m: SimRunMetrics) => number) => mean(runs.map(f));
  return {
    ...first,
    seed: -1,
    endEquity: pick((m) => m.endEquity),
    totalReturnPct: pick((m) => m.totalReturnPct),
    cagrPct: pick((m) => m.cagrPct),
    maxDrawdownPct: pick((m) => m.maxDrawdownPct),
    sharpe: pick((m) => m.sharpe),
    annualisedVolPct: pick((m) => m.annualisedVolPct),
    calmar: pick((m) => m.calmar),
    trades: pick((m) => m.trades),
    buys: pick((m) => m.buys),
    sells: pick((m) => m.sells),
    winRatePct: pick((m) => m.winRatePct),
    finalCashPct: pick((m) => m.finalCashPct),
    distinctSymbols: pick((m) => m.distinctSymbols),
  };
}

export type SimMatrix = {
  perSeed: SimRunMetrics[];
  averaged: SimRunMetrics[];
  universe: AssetSpec[];
  seeds: number[];
};

/** Run every (risk level × horizon × seed) cell. */
export async function runRiskSimMatrix(options: SimMatrixOptions = {}): Promise<SimMatrix> {
  const universe = options.universe ?? DEFAULT_UNIVERSE;
  const horizons = options.horizons ?? HORIZONS;
  const levels = options.riskLevels ?? RISK_LEVELS;
  const startingCash = options.startingCash ?? 10_300;
  const seeds = options.seeds ?? DEFAULT_SEEDS;
  const fee = options.feePerTrade ?? 3;

  const perSeed: SimRunMetrics[] = [];
  const maxBars = Math.max(...horizons.map((h) => h.bars));

  for (const seed of seeds) {
    const fullTape = buildPriceTape(universe, maxBars, seed);
    for (const h of horizons) {
      const tape = fullTape.slice(0, h.bars);
      for (const level of levels) {
        const run = await runRiskLevelSim(level, tape, startingCash, fee);
        perSeed.push(scoreRun(level, h.label, h.bars, seed, startingCash, run));
      }
    }
  }

  const averaged: SimRunMetrics[] = [];
  for (const h of horizons) {
    for (const level of levels) {
      const cell = perSeed.filter((m) => m.horizon === h.label && m.riskLevel === level);
      if (cell.length) averaged.push(averageRuns(cell));
    }
  }

  return { perSeed, averaged, universe, seeds };
}

/** Buy-and-hold equal-weight benchmark over the same tape, for context. */
export function buyAndHoldReturnPct(bars: BacktestBar[]): number {
  if (bars.length < 2) return 0;
  const first = bars[0].closes;
  const last = bars[bars.length - 1].closes;
  const syms = Object.keys(first);
  const rets = syms.map((s) => (last[s] > 0 && first[s] > 0 ? last[s] / first[s] - 1 : 0));
  return mean(rets) * 100;
}
