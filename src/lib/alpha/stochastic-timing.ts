/**
 * Stochastic-oscillator entry timing.
 *
 * The stochastic (%K/%D, 14/3/3) says nothing about *whether* a name is worth
 * owning — the alpha composite already decides that. It is used here purely to
 * time the entry: buying while %K is pinned in overbought territory and rolling
 * over is the worst-priced moment in a swing, whereas a %K cross up through %D
 * out of oversold is the classic low-risk entry.
 *
 * The output is a multiplier in [0, 1] applied to the requested buy notional,
 * exactly like the time-of-day gate. We never scale *above* 1 so every existing
 * sizing cap (cost governor, NAV caps, participation limits) stays binding.
 * Protective/exit orders must never be routed through this gate.
 */

export type StochasticLike = {
  k: number;
  d: number;
  oversold: boolean;
  overbought: boolean;
  bull_cross: boolean;
  bear_cross: boolean;
  bull_cross_from_oversold: boolean;
  rising: boolean;
};

export type StochasticTiming = {
  multiplier: number; // 0..1 applied to buy notional
  allow: boolean; // false = wait for a better entry
  reason: string;
};

export type StochasticTimingConfig = {
  /** Block new buys entirely when overbought and rolling over. Default true. */
  blockOverboughtRollover?: boolean;
  /** Haircut applied while %K is overbought but still rising. Default 0.7. */
  overboughtHaircut?: number;
  /** Haircut applied while %K is falling below %D (no confirmation). Default 0.8. */
  unconfirmedHaircut?: number;
};

const DEFAULTS: Required<StochasticTimingConfig> = {
  blockOverboughtRollover: true,
  overboughtHaircut: 0.7,
  unconfirmedHaircut: 0.8,
};

export function stochasticEntryTiming(
  stoch: StochasticLike | null | undefined,
  config: StochasticTimingConfig = {},
): StochasticTiming {
  const cfg = { ...DEFAULTS, ...config };
  if (!stoch || !Number.isFinite(stoch.k) || !Number.isFinite(stoch.d)) {
    return { multiplier: 1, allow: true, reason: "no stochastic data" };
  }
  const k = Math.max(0, Math.min(100, stoch.k));
  const d = Math.max(0, Math.min(100, stoch.d));
  const tag = `%K ${k.toFixed(0)} / %D ${d.toFixed(0)}`;

  // Best entry: momentum turning up out of an oversold reading.
  if (stoch.bull_cross_from_oversold) {
    return { multiplier: 1, allow: true, reason: `${tag}: bull cross out of oversold` };
  }

  // Worst entry: stretched and turning down.
  if (stoch.overbought && (stoch.bear_cross || !stoch.rising)) {
    if (cfg.blockOverboughtRollover) {
      return { multiplier: 0, allow: false, reason: `${tag}: overbought rollover — wait` };
    }
    return {
      multiplier: cfg.overboughtHaircut * 0.5,
      allow: true,
      reason: `${tag}: overbought rollover haircut`,
    };
  }

  if (stoch.overbought) {
    return {
      multiplier: cfg.overboughtHaircut,
      allow: true,
      reason: `${tag}: overbought but rising — part size`,
    };
  }

  // Oversold and still falling: no turn yet, take a smaller first tranche.
  if (stoch.oversold && !stoch.rising) {
    return {
      multiplier: cfg.unconfirmedHaircut,
      allow: true,
      reason: `${tag}: oversold, no upturn yet`,
    };
  }

  // Mid-range: only require that %K is not cutting down through %D.
  if (stoch.bear_cross || (k < d && !stoch.rising)) {
    return {
      multiplier: cfg.unconfirmedHaircut,
      allow: true,
      reason: `${tag}: %K below %D and falling`,
    };
  }

  return { multiplier: 1, allow: true, reason: `${tag}: timing ok` };
}
