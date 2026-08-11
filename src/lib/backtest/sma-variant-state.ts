// Shared SMA trend-variant state machine used by the walk-forward backtest
// scripts. Kept separate from the scripts so the cost-sensitivity sweep and
// the execution Monte-Carlo run score the *same* signal definition.

export const SMA_VARIANTS = ["sma20", "sma20_50", "sma20_50_200"] as const;
export type SmaVariant = (typeof SMA_VARIANTS)[number];

export type SmaVariantParams = {
  /** Minimum proportional separation before a cross counts as a signal. */
  separationPct: number;
  /** Bars the condition must persist before it fires. */
  confirmBars: number;
};

export function sma(closes: readonly number[], end: number, window: number): number | null {
  if (end + 1 < window) return null;
  let sum = 0;
  for (let i = end - window + 1; i <= end; i++) sum += closes[i]!;
  return sum / window;
}

/** +1 long, 0 flat, null = no opinion — the variant's desired state at bar `i` (no look-ahead). */
export function desiredState(
  variant: SmaVariant,
  closes: readonly number[],
  i: number,
  p: SmaVariantParams,
): 0 | 1 | null {
  const price = closes[i]!;
  const s20 = sma(closes, i, 20);
  if (s20 == null) return null;

  const sepOk = (a: number, b: number) => Math.abs(a - b) / b >= p.separationPct;
  const persisted = (test: (k: number) => boolean | null) => {
    for (let k = i; k > i - p.confirmBars; k--) {
      if (k < 0) return false;
      if (test(k) !== true) return false;
    }
    return true;
  };

  if (variant === "sma20") {
    const bull = (k: number) => {
      const m = sma(closes, k, 20);
      return m == null ? null : closes[k]! > m && sepOk(closes[k]!, m);
    };
    if (persisted(bull)) return 1;
    return price < s20 ? 0 : null;
  }

  const s50 = sma(closes, i, 50);
  if (s50 == null) return null;

  const fastBull = (k: number) => {
    const a = sma(closes, k, 20);
    const b = sma(closes, k, 50);
    return a == null || b == null ? null : a > b && sepOk(a, b);
  };
  const fastBear = (k: number) => {
    const a = sma(closes, k, 20);
    const b = sma(closes, k, 50);
    return a == null || b == null ? null : a < b;
  };

  if (variant === "sma20_50") {
    if (persisted(fastBull)) return 1;
    if (persisted(fastBear)) return 0;
    return null;
  }

  const s200 = sma(closes, i, 200);
  if (s200 == null) return null;
  if (!(s50 > s200)) return 0;
  if (persisted(fastBull)) return 1;
  if (persisted(fastBear)) return 0;
  return null;
}
