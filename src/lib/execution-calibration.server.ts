// Execution calibration — estimates realistic spread / slippage / commission
// from recent daily OHLCV using Corwin-Schultz (2012) and asset-class priors.
// Output is a Partial<ExecutionParams> that plugs into the paper engine.

import type { Candle } from "./market-data.server";
import { getDailyCandlesRange } from "./market-data.server";
import type { AssetClass } from "./universe.server";
import { UNIVERSE } from "./universe.server";
import type { ExecutionParams } from "./execution-realism.server";
import { DEFAULT_EXECUTION } from "./execution-realism.server";

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
