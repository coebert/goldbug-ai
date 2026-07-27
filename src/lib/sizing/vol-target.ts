// Vol-targeted position sizing.
//
// In a market with more algo-driven volatility bursts, a fixed % of NAV
// per position over-risks in high-vol regimes and under-invests in calm
// ones. Vol-target sizing pins expected 1-day vol contribution instead:
//
//   size_fraction = clip(targetVol / max(realizedVol, floor), 0, maxFraction) * base
//
// Pure, deterministic, and monotone-decreasing in `realizedVol`.

export type VolTargetInputs = {
  /** Baseline fraction of NAV the sizer would allocate ignoring vol. */
  baseFraction: number;
  /** Annualised (or period-consistent) target vol, e.g. 0.15 for 15%. */
  targetVol: number;
  /** Realised vol on the same annualisation basis. */
  realizedVol: number;
  /** Hard cap on the resulting fraction of NAV. */
  maxFraction: number;
  /** Floor to avoid divide-by-zero blow-ups in near-flat regimes. */
  realizedVolFloor?: number; // default 0.05
};

export type VolTargetResult = {
  fraction: number;
  scale: number;
  reason: string;
};

export function volTargetSize(i: VolTargetInputs): VolTargetResult {
  const floor = i.realizedVolFloor ?? 0.05;
  const rv = Math.max(floor, Number.isFinite(i.realizedVol) ? i.realizedVol : floor);
  const rawScale = i.targetVol / rv;
  const scale = Math.max(0, Math.min(rawScale, i.maxFraction / Math.max(1e-9, i.baseFraction)));
  const fraction = Math.max(0, Math.min(i.baseFraction * scale, i.maxFraction));
  return {
    fraction,
    scale,
    reason: `target ${(i.targetVol * 100).toFixed(1)}% / realised ${(rv * 100).toFixed(1)}% → ×${scale.toFixed(2)}`,
  };
}
