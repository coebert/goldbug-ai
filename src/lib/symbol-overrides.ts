// Per-symbol trading limits the account owner sets by hand.
//
// Pure module: shapes plus the merge that turns "portfolio-wide rule +
// my override for this name" into the limits the engine actually applies.
// Kept free of Supabase so both the engine and the UI can reason about the
// same effective numbers.

export type SymbolOverride = {
  symbol: string;
  /** Largest share of NAV this one name may take, 0..1. Null = portfolio rule. */
  maxPositionPct: number | null;
  /** Protective stop distance as a fraction of entry. Null = portfolio rule. */
  stopLossPct: number | null;
  /** Profit target distance as a fraction of entry. Null = portfolio rule. */
  takeProfitPct: number | null;
  /** Measured signal strength (0..1) this name must clear before a buy. */
  minSignalStrength: number | null;
  /** Hard stop: no new buys in this name. */
  paused: boolean;
  note: string | null;
  updatedAt: string | null;
};

export type PortfolioLimits = {
  maxPositionPct: number | null;
  stopLossPct: number | null;
  takeProfitPct: number | null;
};

export type EffectiveLimits = {
  maxPositionPct: number | null;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  minSignalStrength: number | null;
  paused: boolean;
  /** Which fields came from the hand-set override rather than the portfolio. */
  overridden: Array<keyof PortfolioLimits | "minSignalStrength" | "paused">;
};

export function emptyOverride(symbol: string): SymbolOverride {
  return {
    symbol,
    maxPositionPct: null,
    stopLossPct: null,
    takeProfitPct: null,
    minSignalStrength: null,
    paused: false,
    note: null,
    updatedAt: null,
  };
}

/** Merge a hand-set override over the portfolio-wide rules. */
export function effectiveLimits(
  base: PortfolioLimits,
  override: SymbolOverride | null | undefined,
): EffectiveLimits {
  const overridden: EffectiveLimits["overridden"] = [];
  const pick = <K extends keyof PortfolioLimits>(key: K): number | null => {
    const v = override?.[key] ?? null;
    if (v != null && Number.isFinite(v)) {
      overridden.push(key);
      return v;
    }
    return base[key] ?? null;
  };

  const maxPositionPct = pick("maxPositionPct");
  const stopLossPct = pick("stopLossPct");
  const takeProfitPct = pick("takeProfitPct");
  const minSignalStrength =
    override?.minSignalStrength != null && Number.isFinite(override.minSignalStrength)
      ? override.minSignalStrength
      : null;
  if (minSignalStrength != null) overridden.push("minSignalStrength");
  if (override?.paused) overridden.push("paused");

  return {
    maxPositionPct,
    stopLossPct,
    takeProfitPct,
    minSignalStrength,
    paused: Boolean(override?.paused),
    overridden,
  };
}

/**
 * Does a buy in this name clear the hand-set gates? Sells are never gated —
 * a paused name must still be exitable.
 */
export function buyBlockReason(
  limits: EffectiveLimits,
  strength: number | null,
): string | null {
  if (limits.paused) return "paused by hand on the symbol page";
  if (
    limits.minSignalStrength != null &&
    strength != null &&
    strength < limits.minSignalStrength
  ) {
    return (
      `signal strength ${(strength * 100).toFixed(0)}% is below the ` +
      `${(limits.minSignalStrength * 100).toFixed(0)}% floor set by hand`
    );
  }
  return null;
}
