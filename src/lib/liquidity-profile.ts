// Per-symbol liquidity profile derived from a real daily tape.
//
// The cost sweep used to assume a single flat slippage number for every
// name. That flatters small caps and punishes SPY. This module turns the
// raw daily history we already fetch (close + volume) into the two inputs
// the microstructure model in `spread-slippage.ts` actually needs:
//
//   adv20d   median daily traded VALUE (close * volume) over a trailing
//            window — median rather than mean so one earnings-day volume
//            spike doesn't make a thin name look liquid.
//   atrPct   close-to-close mean absolute return over the same window,
//            used as the volatility proxy for spread widening and the
//            sqrt-impact sigma term.
//
// Everything here is pure and deterministic: same bars in, same profile
// out, so sweeps stay reproducible.

import type { AssetClass } from "./universe.server";
import type { RawDailyBar, SymbolHistory } from "./real-market-tape";

export type SymbolLiquidity = {
  symbol: string;
  /** Median daily traded value (price units × volume). 0 when unknown. */
  adv20d: number;
  /** Mean absolute daily return over the window (0.018 = 1.8%). */
  atrPct: number;
  /** Bars that contributed a usable (price, volume) pair. */
  samples: number;
  /** True when the provider gave us no volume and ADV had to be dropped. */
  advMissing: boolean;
};

export type LiquidityProfile = {
  adv20dBySymbol: Record<string, number>;
  atrPctBySymbol: Record<string, number>;
  /** Median ADV across covered symbols — the fallback for unknown names. */
  medianAdv: number;
  /** Median ATR% across covered symbols. */
  medianAtrPct: number;
  bySymbol: SymbolLiquidity[];
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Liquidity + volatility stats for one symbol's bars. */
export function symbolLiquidity(
  symbol: string,
  bars: readonly RawDailyBar[],
  opts: { window?: number } = {},
): SymbolLiquidity {
  const window = Math.max(5, opts.window ?? 60);
  const usable = bars.filter((b) => Number.isFinite(b.close) && b.close > 0);
  const tail = usable.slice(-window);

  const values: number[] = [];
  for (const b of tail) {
    const vol = Number(b.volume);
    if (Number.isFinite(vol) && vol > 0) values.push(b.close * vol);
  }

  const rets: number[] = [];
  for (let i = 1; i < tail.length; i += 1) {
    const prev = tail[i - 1]!.close;
    const cur = tail[i]!.close;
    if (prev > 0) rets.push(Math.abs(cur / prev - 1));
  }
  const atrPct = rets.length
    ? rets.reduce((a, b) => a + b, 0) / rets.length
    : 0;

  return {
    symbol,
    adv20d: median(values),
    atrPct: Number(atrPct.toFixed(6)),
    samples: tail.length,
    advMissing: values.length === 0,
  };
}

/**
 * Build the whole-universe liquidity profile from the histories the tape
 * was built from. Symbols with no reported volume fall back to the
 * cross-sectional median ADV so they are still size-penalised sanely
 * rather than treated as infinitely deep.
 */
export function buildLiquidityProfile(
  histories: readonly SymbolHistory[],
  opts: { window?: number } = {},
): LiquidityProfile {
  const bySymbol = histories.map((h) => symbolLiquidity(h.symbol, h.bars, opts));
  const medianAdv = median(bySymbol.filter((s) => !s.advMissing).map((s) => s.adv20d));
  const medianAtrPct = median(bySymbol.filter((s) => s.atrPct > 0).map((s) => s.atrPct));

  const adv20dBySymbol: Record<string, number> = {};
  const atrPctBySymbol: Record<string, number> = {};
  for (const s of bySymbol) {
    adv20dBySymbol[s.symbol] = s.advMissing || s.adv20d <= 0 ? medianAdv : s.adv20d;
    atrPctBySymbol[s.symbol] = s.atrPct > 0 ? s.atrPct : medianAtrPct;
  }

  return { adv20dBySymbol, atrPctBySymbol, medianAdv, medianAtrPct, bySymbol };
}

/**
 * Scale every ADV by a constant — the "how thin is the book?" sweep axis.
 * `0.25` simulates trading names a quarter as liquid as the sample (or,
 * equivalently, tickets 4x larger relative to the book).
 */
export function scaleLiquidity(profile: LiquidityProfile, advScale: number): LiquidityProfile {
  if (!Number.isFinite(advScale) || advScale <= 0) {
    throw new Error(`scaleLiquidity: invalid advScale ${advScale}`);
  }
  const adv20dBySymbol: Record<string, number> = {};
  for (const [k, v] of Object.entries(profile.adv20dBySymbol)) {
    adv20dBySymbol[k] = v * advScale;
  }
  return {
    ...profile,
    adv20dBySymbol,
    medianAdv: profile.medianAdv * advScale,
    bySymbol: profile.bySymbol.map((s) => ({ ...s, adv20d: s.adv20d * advScale })),
  };
}

/** Shape the simulator consumes (see `Frictions.liquidity`). */
export type LiquidityFrictions = {
  adv20dBySymbol?: Record<string, number>;
  atrPctBySymbol?: Record<string, number>;
  assetClassBySymbol?: Record<string, AssetClass>;
  currencyBySymbol?: Record<string, string>;
  defaultAdv20d?: number;
  defaultAtrPct?: number;
  urgency?: "passive" | "normal" | "aggressive";
  /** Multiplier on the modelled per-side bps (stress/relief factor). */
  costScale?: number;
};

/** Convert a profile into the friction block the simulator understands. */
export function liquidityFrictions(
  profile: LiquidityProfile,
  extra: Omit<LiquidityFrictions, "adv20dBySymbol" | "atrPctBySymbol"> = {},
): LiquidityFrictions {
  return {
    adv20dBySymbol: profile.adv20dBySymbol,
    atrPctBySymbol: profile.atrPctBySymbol,
    defaultAdv20d: profile.medianAdv,
    defaultAtrPct: profile.medianAtrPct,
    ...extra,
  };
}
