// Execution calibration — estimates realistic spread / slippage / commission
// AND per-symbol microstructure tuning (ADV notional, realized vol, impact
// coefficient, vol-widening coefficient) from recent daily OHLCV.
//
// Output is:
//   1) a Partial<ExecutionParams>  → legacy paper engine
//   2) per-symbol SpreadSlippageTuning overrides → tightens market-impact and
//      ATR-based spread assumptions in the live trading engine
//   3) rows persisted to `public.execution_calibrations` for reuse and UI

import type { Candle } from "./market-data.server";
import { getDailyCandlesRange } from "./market-data.server";
import type { AssetClass } from "./universe.server";
import { UNIVERSE } from "./universe.server";
import type { ExecutionParams } from "./execution-realism.server";
import { DEFAULT_EXECUTION } from "./execution-realism.server";
import {
  BASE_SPREAD_BPS_BY_CLASS,
  DEFAULT_TUNING,
  VENUE_SPREAD_MULT,
  type SpreadSlippageTuning,
} from "./spread-slippage";
import { supabaseAdmin } from "@/integrations/supabase/client.server";



// Broker-level commission floors (round-trip per side, bps).
const COMMISSION_FLOOR_BPS: Record<AssetClass, number> = {
  stock: 3,
  etf: 3,
  crypto: 15,
  commodity: 5,
  fx: 2,
};

// Minimum credible slippage per asset class (bps per side).
const SLIPPAGE_FLOOR_BPS: Record<AssetClass, number> = {
  stock: 2,
  etf: 1,
  crypto: 10,
  commodity: 4,
  fx: 1,
};

export type SymbolCalibration = {
  symbol: string;
  asset_class: AssetClass;
  n_pairs: number;
  spread_pct_est: number | null;   // Corwin-Schultz proportional spread (e.g. 0.0012 = 12 bps)
  atr_pct_est: number | null;      // 14-day ATR%
  slippage_bps_est: number;
  commission_bps_est: number;
  spread_atr_frac_est: number | null;
};

export type CalibrationSummary = {
  as_of: string;
  window_days: number;
  n_symbols: number;
  per_symbol: SymbolCalibration[];
  recommended: ExecutionParams;
  notes: string[];
};

// ----- helpers ----------------------------------------------------------

function ln(x: number): number {
  return Math.log(x);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Corwin-Schultz high-low spread estimator (Journal of Finance, 2012).
// Returns proportional spread S (fraction of price). Negative daily estimates
// are floored at 0, per the paper's practical guidance.
export function corwinSchultzSpread(bars: Candle[]): number | null {
  if (bars.length < 2) return null;
  const K1 = 4 * Math.log(2); // constant in denominators
  const gammaDen = 3 - 2 * Math.sqrt(2);
  const spreads: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const a = bars[i - 1];
    const b = bars[i];
    if (!(a.high > 0 && a.low > 0 && b.high > 0 && b.low > 0)) continue;
    // Overnight-return adjustment: shift day-t high/low so the close-to-open
    // gap doesn't inflate γ (per Corwin-Schultz Appendix A).
    const gap = Math.max(0, a.close - b.open) - Math.max(0, b.open - a.close);
    const H1 = a.high - gap;
    const L1 = a.low - gap;
    if (H1 <= 0 || L1 <= 0) continue;
    const beta =
      ln(H1 / L1) ** 2 + ln(b.high / b.low) ** 2;
    const H2 = Math.max(H1, b.high);
    const L2 = Math.min(L1, b.low);
    const gamma = ln(H2 / L2) ** 2;
    const alpha =
      (Math.sqrt(2 * beta) - Math.sqrt(beta)) / gammaDen -
      Math.sqrt(gamma / gammaDen);
    const s = (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha));
    if (Number.isFinite(s)) spreads.push(Math.max(0, s));
  }
  if (spreads.length < 5) return null;
  // Use a trimmed mean to blunt earnings-day outliers.
  spreads.sort((x, y) => x - y);
  const trim = Math.floor(spreads.length * 0.1);
  const core = spreads.slice(trim, spreads.length - trim);
  return core.reduce((x, y) => x + y, 0) / core.length;
}

// 14-day ATR% (Wilder), returned as a fraction of last close.
export function atrPct(bars: Candle[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const p = bars[i - 1];
    const c = bars[i];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    );
    trs.push(tr);
  }
  // Wilder smoothing
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i += 1) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  const last = bars[bars.length - 1].close;
  return last > 0 ? atr / last : null;
}

// ----- main calibration -------------------------------------------------

function assetClassFor(symbol: string): AssetClass {
  const found = UNIVERSE.find((u) => u.symbol.toUpperCase() === symbol.toUpperCase());
  return found?.asset_class ?? "stock";
}

async function calibrateSymbol(
  symbol: string,
  lookbackDays: number,
  asOf: string,
): Promise<SymbolCalibration> {
  const cls = assetClassFor(symbol);
  const end = new Date(asOf);
  const start = new Date(end);
  start.setDate(end.getDate() - lookbackDays - 5);
  const bars = await getDailyCandlesRange(
    symbol,
    start.toISOString().slice(0, 10),
    asOf,
  ).catch(() => [] as Candle[]);

  const spread = corwinSchultzSpread(bars);
  const atr = atrPct(bars);

  // Slippage: model as half of the estimated round-trip spread, plus a
  // liquidity impact term proxied by 5% of ATR. Floor per asset class.
  const spreadBps = spread != null ? spread * 10_000 : null;
  const atrBps = atr != null ? atr * 10_000 : null;
  const modelledSlipBps = Math.max(
    SLIPPAGE_FLOOR_BPS[cls],
    (spreadBps ?? 0) * 0.5 + (atrBps ?? 0) * 0.05,
  );

  // spread_atr_frac: half-spread as a fraction of ATR (so multiplying by ATR
  // in the engine reproduces the half-spread we saw historically).
  let spreadAtrFrac: number | null = null;
  if (spread != null && atr != null && atr > 0) {
    spreadAtrFrac = Math.max(0, Math.min(1, spread / 2 / atr));
  }

  return {
    symbol,
    asset_class: cls,
    n_pairs: Math.max(0, bars.length - 1),
    spread_pct_est: spread,
    atr_pct_est: atr,
    slippage_bps_est: Math.round(modelledSlipBps * 10) / 10,
    commission_bps_est: COMMISSION_FLOOR_BPS[cls],
    spread_atr_frac_est: spreadAtrFrac,
  };
}

export async function calibrateExecution(
  symbols: string[],
  opts: { lookbackDays?: number; asOf?: string } = {},
): Promise<CalibrationSummary> {
  const lookbackDays = opts.lookbackDays ?? 90;
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase())));

  const perSymbol: SymbolCalibration[] = [];
  // Serial to avoid hammering the price cache; the sample is <30 symbols.
  for (const s of uniq) {
    try {
      perSymbol.push(await calibrateSymbol(s, lookbackDays, asOf));
    } catch (_e) {
      // Skip unreachable symbols; keep the calibration best-effort.
    }
  }

  const notes: string[] = [];
  const usable = perSymbol.filter((r) => r.n_pairs >= 20);
  if (!usable.length) {
    notes.push("No symbol had enough recent bars — falling back to defaults.");
    return {
      as_of: asOf,
      window_days: lookbackDays,
      n_symbols: perSymbol.length,
      per_symbol: perSymbol,
      recommended: { ...DEFAULT_EXECUTION },
      notes,
    };
  }

  const medSlip = median(usable.map((r) => r.slippage_bps_est)) ?? DEFAULT_EXECUTION.slippage_bps;
  const medCommission = median(usable.map((r) => r.commission_bps_est)) ?? DEFAULT_EXECUTION.commission_bps;
  const medFrac =
    median(
      usable
        .map((r) => r.spread_atr_frac_est)
        .filter((v): v is number => v != null),
    ) ?? DEFAULT_EXECUTION.spread_atr_frac;

  // Blend cautiously with defaults so a thin sample does not swing the model.
  const blend = (est: number, def: number, w = 0.75) => est * w + def * (1 - w);

  const recommended: ExecutionParams = {
    ...DEFAULT_EXECUTION,
    slippage_bps: Math.round(blend(medSlip, DEFAULT_EXECUTION.slippage_bps) * 10) / 10,
    commission_bps: Math.round(blend(medCommission, DEFAULT_EXECUTION.commission_bps) * 10) / 10,
    spread_atr_frac: Math.round(blend(medFrac, DEFAULT_EXECUTION.spread_atr_frac) * 1000) / 1000,
  };

  notes.push(
    `Median half-spread≈${((medFrac * 100)).toFixed(1)}% of ATR across ${usable.length} liquid symbols.`,
    `Slippage median ${medSlip.toFixed(1)}bps, commission ${medCommission.toFixed(1)}bps per side.`,
    "Blended 75/25 with defaults to damp thin-sample noise.",
  );

  return {
    as_of: asOf,
    window_days: lookbackDays,
    n_symbols: perSymbol.length,
    per_symbol: perSymbol,
    recommended,
    notes,
  };
}

// =====================================================================
// Per-symbol microstructure calibration (ADV$, realized vol, tuning)
// =====================================================================


/** Currency inferred from Yahoo suffix — good enough for banding ADV notional
 *  and picking the venue spread multiplier. */
export function inferCurrency(symbol: string): string {
  const u = symbol.toUpperCase();
  if (u.endsWith(".L")) return "GBP";
  if (u.endsWith(".DE") || u.endsWith(".PA") || u.endsWith(".MI") || u.endsWith(".AS")) return "EUR";
  if (u.endsWith(".SW")) return "CHF";
  if (u.endsWith(".T")) return "JPY";
  if (u.endsWith(".HK")) return "HKD";
  if (u.endsWith(".AX")) return "AUD";
  if (u.endsWith(".TO")) return "CAD";
  if (u.endsWith("-USD")) return "USD";
  if (u.endsWith("=X")) return "USD";
  return "USD";
}

/** Average daily traded notional over last N bars (close × volume). Returned
 *  in the instrument's own quote currency. LSE .L closes are in GBX so callers
 *  should treat this as a relative liquidity band, not a strict GBP figure. */
export function averageDailyNotional(bars: Candle[], period = 20): number | null {
  if (bars.length < Math.min(period, 5)) return null;
  const slice = bars.slice(-period);
  const vals = slice
    .map((c) => (c.close > 0 && c.volume > 0 ? c.close * c.volume : 0))
    .filter((v) => v > 0);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Standard deviation of daily log returns over the last `n` bars. Population
 *  form (matches typical realized-vol convention). */
export function realizedDailyVol(bars: Candle[], n = 60): number | null {
  if (bars.length < 10) return null;
  const slice = bars.slice(-Math.min(n + 1, bars.length));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i += 1) {
    const p0 = slice[i - 1].close;
    const p1 = slice[i].close;
    if (p0 > 0 && p1 > 0) rets.push(Math.log(p1 / p0));
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varr);
}

export type PerSymbolMicrostructure = {
  symbol: string;
  asset_class: AssetClass;
  currency: string;
  as_of: string;
  sample_days: number;
  adv_shares_20d: number | null;
  adv_notional_20d: number | null;
  adv_notional_60d: number | null;
  realized_vol_daily: number | null;
  atr_pct_14d: number | null;
  spread_pct_est: number | null;
  half_spread_bps_est: number | null;
  /** Derived tuning that tightens the microstructure model for this symbol. */
  tuning: SpreadSlippageTuning;
  notes: string[];
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Derive a per-symbol SpreadSlippageTuning from observed liquidity + spread.
 *
 *  - `vol_widening_coeff_bps` is fit so `baseHalf + coeff*ATR%` reproduces the
 *    observed Corwin-Schultz half-spread. Falls back to the default when we
 *    lack a usable spread reading.
 *  - `impact_coeff` scales the default 12 by a liquidity band derived from
 *    ADV notional. Illiquid names widen; deep names tighten (a $1B/day ETF
 *    should not pay 12bps of impact at 1% ADV).
 *  - `max_impact_bps` / `max_half_spread_bps` widen for illiquid names so
 *    stress-day sizing still respects reality.
 */
export function deriveTuning(input: {
  assetClass: AssetClass;
  currency: string;
  atrPct: number | null;
  spreadPct: number | null;
  advNotional20d: number | null;
}): { tuning: SpreadSlippageTuning; notes: string[] } {
  const notes: string[] = [];
  const cls = input.assetClass;
  const baseRoundTrip = BASE_SPREAD_BPS_BY_CLASS[cls] ?? 10;
  const venueMult = VENUE_SPREAD_MULT[input.currency] ?? 1;
  const baseHalf = (baseRoundTrip * venueMult) / 2;

  // Half-spread widening coefficient (bps per unit ATR%).
  let volCoeff = DEFAULT_TUNING.vol_widening_coeff_bps;
  if (input.spreadPct != null && input.atrPct && input.atrPct > 0) {
    const observedHalfBps = (input.spreadPct * 10_000) / 2;
    const widening = observedHalfBps - baseHalf;
    const fitted = widening / input.atrPct;
    // Blend 60% observed / 40% default; clamp to sane range.
    const blended = 0.6 * fitted + 0.4 * DEFAULT_TUNING.vol_widening_coeff_bps;
    volCoeff = clamp(blended, 0, 400);
    notes.push(
      `vol widening coeff fit ${fitted.toFixed(0)}bps → blended ${volCoeff.toFixed(0)}bps`,
    );
  } else {
    notes.push("insufficient spread/ATR sample, keeping default vol coeff");
  }

  // Impact coefficient — scale by ADV liquidity band.
  //   $1B+/day  → 0.5×   deep, minimal impact
  //   $100M/day → 1.0×   default
  //   $10M/day  → ~2×    tighten small orders
  //   <$1M/day  → cap at 3×
  let impactMult = 1;
  if (input.advNotional20d && input.advNotional20d > 0) {
    impactMult = clamp(Math.sqrt(1e8 / input.advNotional20d), 0.4, 3);
  }
  const impactCoeff = clamp(
    DEFAULT_TUNING.impact_coeff * impactMult,
    3,
    40,
  );
  notes.push(
    `impact_coeff ${impactCoeff.toFixed(1)} (mult ${impactMult.toFixed(2)}× vs default 12)`,
  );

  // Caps: illiquid names allowed to widen more, deep names tightened.
  const halfCap = clamp(3 * (baseHalf + volCoeff * (input.atrPct ?? 0.02)), 40, 300);
  const impactCap = impactMult > 1.5 ? 200 : DEFAULT_TUNING.max_impact_bps;

  const tuning: SpreadSlippageTuning = {
    ...DEFAULT_TUNING,
    vol_widening_coeff_bps: Math.round(volCoeff),
    impact_coeff: Math.round(impactCoeff * 10) / 10,
    max_half_spread_bps: Math.round(halfCap),
    max_impact_bps: Math.round(impactCap),
  };
  return { tuning, notes };
}

/** Full per-symbol calibration: pulls bars, computes ADV$/vol/ATR/CS spread,
 *  derives tuning, returns a normalised row. Does not touch the DB. */
export async function calibrateSymbolMicrostructure(
  symbol: string,
  opts: { lookbackDays?: number; asOf?: string } = {},
): Promise<PerSymbolMicrostructure | null> {
  const lookbackDays = opts.lookbackDays ?? 90;
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const cls = assetClassFor(symbol);
  const currency = inferCurrency(symbol);

  const end = new Date(asOf);
  const start = new Date(end);
  start.setDate(end.getDate() - lookbackDays - 5);
  const bars = await getDailyCandlesRange(
    symbol,
    start.toISOString().slice(0, 10),
    asOf,
  ).catch(() => [] as Candle[]);

  if (bars.length < 15) return null;

  const spread = corwinSchultzSpread(bars);
  const atr = atrPct(bars);
  const advShares = bars.slice(-20).reduce((a, b) => a + (b.volume > 0 ? b.volume : 0), 0)
    / Math.max(1, bars.slice(-20).filter((b) => b.volume > 0).length);
  const advNotional20 = averageDailyNotional(bars, 20);
  const advNotional60 = averageDailyNotional(bars, 60);
  const rv = realizedDailyVol(bars, 60);

  const halfSpreadBps = spread != null ? (spread * 10_000) / 2 : null;
  const { tuning, notes } = deriveTuning({
    assetClass: cls,
    currency,
    atrPct: atr,
    spreadPct: spread,
    advNotional20d: advNotional20,
  });

  return {
    symbol: symbol.toUpperCase(),
    asset_class: cls,
    currency,
    as_of: asOf,
    sample_days: bars.length,
    adv_shares_20d: Number.isFinite(advShares) ? advShares : null,
    adv_notional_20d: advNotional20,
    adv_notional_60d: advNotional60,
    realized_vol_daily: rv,
    atr_pct_14d: atr,
    spread_pct_est: spread,
    half_spread_bps_est: halfSpreadBps,
    tuning,
    notes,
  };
}

/** Run per-symbol calibration across the universe (or a supplied list) and
 *  upsert into `public.execution_calibrations`. Best-effort — symbols with
 *  insufficient data are skipped. Returns the persisted rows. */
export async function calibrateAndPersist(
  symbols?: string[],
  opts: { lookbackDays?: number; asOf?: string } = {},
): Promise<{ persisted: PerSymbolMicrostructure[]; skipped: string[] }> {
  const list = (symbols?.length ? symbols : UNIVERSE.map((u) => u.symbol))
    .map((s) => s.toUpperCase());
  const uniq = Array.from(new Set(list));

  const persisted: PerSymbolMicrostructure[] = [];
  const skipped: string[] = [];

  // Serial to avoid hammering the price cache / Yahoo.
  for (const s of uniq) {
    try {
      const row = await calibrateSymbolMicrostructure(s, opts);
      if (!row) {
        skipped.push(s);
        continue;
      }
      persisted.push(row);
    } catch {
      skipped.push(s);
    }
  }

  if (persisted.length) {
    const payload = persisted.map((r) => ({
      symbol: r.symbol,
      asset_class: r.asset_class,
      currency: r.currency,
      as_of: r.as_of,
      sample_days: r.sample_days,
      adv_shares_20d: r.adv_shares_20d,
      adv_notional_20d: r.adv_notional_20d,
      adv_notional_60d: r.adv_notional_60d,
      realized_vol_daily: r.realized_vol_daily,
      atr_pct_14d: r.atr_pct_14d,
      spread_pct_est: r.spread_pct_est,
      half_spread_bps_est: r.half_spread_bps_est,
      vol_widening_coeff_bps_est: r.tuning.vol_widening_coeff_bps,
      impact_coeff_est: r.tuning.impact_coeff,
      max_impact_bps_est: r.tuning.max_impact_bps,
      max_half_spread_bps_est: r.tuning.max_half_spread_bps,
      notes: r.notes.join("; "),
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabaseAdmin
      .from("execution_calibrations")
      .upsert(payload, { onConflict: "symbol" });
    if (error) throw new Error(`persist calibration: ${error.message}`);
  }

  return { persisted, skipped };
}

/** Load persisted tuning for a set of symbols. Returns a Map that the trading
 *  engine merges into ExecutionParams.microstructure per order. Missing rows
 *  fall back to DEFAULT_TUNING at call-site. */
export async function loadTuningForSymbols(
  symbols: string[],
): Promise<Map<string, SpreadSlippageTuning>> {
  const map = new Map<string, SpreadSlippageTuning>();
  if (!symbols.length) return map;
  const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const { data, error } = await supabaseAdmin
    .from("execution_calibrations")
    .select("symbol, vol_widening_coeff_bps_est, impact_coeff_est, max_impact_bps_est, max_half_spread_bps_est")
    .in("symbol", uniq);
  if (error || !data) return map;
  for (const r of data) {
    const t: SpreadSlippageTuning = {
      ...DEFAULT_TUNING,
      vol_widening_coeff_bps: Number(r.vol_widening_coeff_bps_est ?? DEFAULT_TUNING.vol_widening_coeff_bps),
      impact_coeff: Number(r.impact_coeff_est ?? DEFAULT_TUNING.impact_coeff),
      max_impact_bps: Number(r.max_impact_bps_est ?? DEFAULT_TUNING.max_impact_bps),
      max_half_spread_bps: Number(r.max_half_spread_bps_est ?? DEFAULT_TUNING.max_half_spread_bps),
    };
    map.set(String(r.symbol).toUpperCase(), t);
  }
  return map;
}
