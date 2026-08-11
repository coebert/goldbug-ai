// Per-symbol execution-cost calibration from recent daily bars.
//
// The cost-sensitivity sweep used hand-picked scenarios (5bps slip, £8 flat,
// "punitive"…). Those bracket the truth but none of them IS the truth for a
// given name: SPY and a thin LSE ETC do not pay the same spread, and a £250
// ticket in a £2bn/day name has no impact at all.
//
// This module estimates, per symbol, from history we already have:
//
//   • half-spread  — Corwin-Schultz (2012) two-day high/low estimator when
//                    highs/lows exist, else Roll (1984) serial-covariance,
//                    else the per-asset-class floor from `spread-slippage`.
//                    All three are floored by the class/venue base so a
//                    degenerate estimate can never make trading look free.
//   • sigma / ATR% — mean absolute daily return over the window.
//   • ADV          — median close × volume (trade currency), robust to spikes.
//   • commission   — the real Saxo venue tier for the inferred currency,
//                    including the min-ticket floor.
//
// It is I/O-free: callers pass bars. `executionCostFor` then prices any
// notional through commission + calibrated half-spread + sqrt-law impact.

import type { AssetClass } from "./universe.server";
import { estimateSaxoCommission, inferSaxoCurrency } from "./saxo-fees";
import {
  BASE_SPREAD_BPS_BY_CLASS,
  VENUE_SPREAD_MULT,
  DEFAULT_TUNING,
  estimateSpreadSlippage,
  type OrderUrgency,
} from "./spread-slippage";

export type CalibBar = {
  date: string;
  close: number;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
};

export type SpreadSource = "corwin_schultz" | "roll" | "class_floor";

export type SymbolExecutionCalibration = {
  symbol: string;
  currency: string;
  assetClass: AssetClass;
  /** Bars actually used by the estimators. */
  sampleBars: number;
  /** Mean absolute daily return over the window, as a fraction. */
  atrPct: number;
  /** Median daily traded value in trade currency. 0 when volume is absent. */
  adv20d: number;
  /** Calibrated per-side half-spread, bps of mid. */
  halfSpreadBps: number;
  /** Raw estimator output before the class floor was applied, bps. */
  rawHalfSpreadBps: number | null;
  /** Floor that was applied (class base × venue multiplier ÷ 2), bps. */
  floorHalfSpreadBps: number;
  spreadSource: SpreadSource;
  /** Saxo commission rate/floor in force for this venue. */
  commissionRateBps: number;
  commissionMin: number;
  notes: string[];
};

const SQRT2 = Math.SQRT2;
const CS_K = 3 - 2 * SQRT2;

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const finite = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Class + venue floor on the per-side half-spread, in bps. */
export function floorHalfSpreadBps(
  assetClass: AssetClass | null | undefined,
  currency: string | null | undefined,
): number {
  const base = (assetClass ? BASE_SPREAD_BPS_BY_CLASS[assetClass] : undefined) ?? 10;
  const mult = (currency ? VENUE_SPREAD_MULT[currency.toUpperCase()] : undefined) ?? 1;
  return (base * mult) / 2;
}

/**
 * Corwin-Schultz proportional (round-trip) spread from two-day high/low
 * ranges. Returns the median of the non-negative daily estimates, or null
 * when the sample has no usable high/low pairs.
 */
export function corwinSchultzSpread(bars: readonly CalibBar[]): number | null {
  const est: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h0 = finite(bars[i - 1]!.high);
    const l0 = finite(bars[i - 1]!.low);
    const h1 = finite(bars[i]!.high);
    const l1 = finite(bars[i]!.low);
    if (!h0 || !l0 || !h1 || !l1 || h0 <= 0 || l0 <= 0 || h1 <= 0 || l1 <= 0) continue;
    if (h0 < l0 || h1 < l1) continue;
    const beta = Math.log(h0 / l0) ** 2 + Math.log(h1 / l1) ** 2;
    const gamma = Math.log(Math.max(h0, h1) / Math.min(l0, l1)) ** 2;
    const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / CS_K - Math.sqrt(gamma / CS_K);
    const s = (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha));
    // Negative estimates are the documented small-sample artefact; the
    // estimator's own remedy is to floor them at zero before averaging.
    if (Number.isFinite(s)) est.push(Math.max(0, s));
  }
  return est.length >= 5 ? median(est) : null;
}

/**
 * Roll (1984) effective proportional spread from the serial covariance of
 * close-to-close changes. Null when the covariance is non-negative (the
 * estimator is undefined there, which happens in trending samples).
 */
export function rollSpread(bars: readonly CalibBar[]): number | null {
  const d: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = finite(bars[i - 1]!.close);
    const b = finite(bars[i]!.close);
    if (!a || !b || a <= 0 || b <= 0) continue;
    d.push(b - a);
  }
  if (d.length < 30) return null;
  const mean = d.reduce((s, v) => s + v, 0) / d.length;
  let cov = 0;
  for (let i = 1; i < d.length; i++) cov += (d[i]! - mean) * (d[i - 1]! - mean);
  cov /= d.length - 1;
  if (!(cov < 0)) return null;
  const priceLevel = median(bars.map((b) => finite(b.close) ?? 0).filter((v) => v > 0));
  if (!(priceLevel > 0)) return null;
  return (2 * Math.sqrt(-cov)) / priceLevel;
}

export type CalibrateInput = {
  symbol: string;
  bars: readonly CalibBar[];
  currency?: string | null;
  assetClass?: AssetClass | null;
  /** Trailing bars to calibrate on. Default 252 (~1y). */
  window?: number;
};

/** Estimate the execution profile of one symbol from its recent bars. */
export function calibrateSymbolExecution(input: CalibrateInput): SymbolExecutionCalibration {
  const window = Math.max(30, input.window ?? 252);
  const bars = input.bars.slice(-window);
  const currency = (input.currency ?? inferSaxoCurrency(input.symbol)).toUpperCase();
  const assetClass = input.assetClass ?? "stock";
  const notes: string[] = [];

  // Volatility: mean absolute daily return (same convention `atrPct` uses
  // elsewhere in the codebase).
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = finite(bars[i - 1]!.close);
    const b = finite(bars[i]!.close);
    if (a && b && a > 0) rets.push(Math.abs(b / a - 1));
  }
  const atrPct = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;

  // Liquidity: median traded value, robust to single-day volume spikes.
  const values = bars
    .map((b) => {
      const c = finite(b.close);
      const v = finite(b.volume);
      return c && v && c > 0 && v > 0 ? c * v : null;
    })
    .filter((v): v is number => v != null);
  const adv20d = values.length >= 10 ? median(values) : 0;

  const floor = floorHalfSpreadBps(assetClass, currency);
  let rawHalfSpreadBps: number | null = null;
  let spreadSource: SpreadSource = "class_floor";

  const cs = corwinSchultzSpread(bars);
  if (cs != null) {
    rawHalfSpreadBps = (cs / 2) * 10_000;
    spreadSource = "corwin_schultz";
  } else {
    const roll = rollSpread(bars);
    if (roll != null) {
      rawHalfSpreadBps = (roll / 2) * 10_000;
      spreadSource = "roll";
    }
  }

  // Never let an estimator make trading look cheaper than the venue floor,
  // and cap it with the same ceiling the slippage model uses.
  const halfSpreadBps = Math.min(
    DEFAULT_TUNING.max_half_spread_bps,
    Math.max(floor, rawHalfSpreadBps ?? floor),
  );
  notes.push(
    `${spreadSource} half-spread ${(rawHalfSpreadBps ?? floor).toFixed(1)}bps`
    + ` → ${halfSpreadBps.toFixed(1)}bps after ${floor.toFixed(1)}bps ${currency} floor`,
  );
  if (adv20d <= 0) notes.push("no volume in sample — impact modelled as zero");

  const fee = estimateSaxoCommission({ notional: 10_000, currency, assetClass });

  return {
    symbol: input.symbol,
    currency,
    assetClass,
    sampleBars: bars.length,
    atrPct,
    adv20d,
    halfSpreadBps,
    rawHalfSpreadBps,
    floorHalfSpreadBps: floor,
    spreadSource,
    commissionRateBps: fee.tier.rate * 10_000,
    commissionMin: fee.tier.min,
    notes,
  };
}

/** Calibrate a whole universe, keyed by symbol. */
export function calibrateUniverseExecution(
  inputs: readonly CalibrateInput[],
): Map<string, SymbolExecutionCalibration> {
  const out = new Map<string, SymbolExecutionCalibration>();
  for (const i of inputs) out.set(i.symbol, calibrateSymbolExecution(i));
  return out;
}

export type CalibratedCost = {
  commission: number;
  spread: number;
  impact: number;
  total: number;
  totalBps: number;
  participation: number;
};

/**
 * Price one side of a trade of `notional` under a calibrated profile:
 * real venue commission (with floor) + calibrated half-spread + latency +
 * sqrt-law market impact.
 */
export function executionCostFor(
  calib: SymbolExecutionCalibration,
  notional: number,
  urgency: OrderUrgency = "normal",
  scale = 1,
): CalibratedCost {
  const n = Math.max(0, Number(notional) || 0);
  if (n === 0) {
    return { commission: 0, spread: 0, impact: 0, total: 0, totalBps: 0, participation: 0 };
  }
  const commission = estimateSaxoCommission({
    notional: n,
    currency: calib.currency,
    assetClass: calib.assetClass,
  }).commission;

  const model = estimateSpreadSlippage({
    assetClass: calib.assetClass,
    currency: calib.currency,
    atrPct: calib.atrPct,
    notional: n,
    adv20d: calib.adv20d,
    urgency,
  });

  // Swap the model's generic base half-spread for the calibrated one; keep
  // its latency/impact/urgency legs.
  const spreadBps = Math.max(0, calib.halfSpreadBps * scale + model.urgencyBps);
  const slipBps = (model.latencyBps + model.impactBps) * scale;
  const spread = (n * spreadBps) / 10_000;
  const impact = (n * slipBps) / 10_000;
  const total = commission + spread + impact;

  return {
    commission,
    spread,
    impact,
    total,
    totalBps: (total / n) * 10_000,
    participation: model.participation,
  };
}
