
/**
 * Format a metric value for the equity-curve tiles.
 *
 * Degenerate backtests can produce astronomically large annualised figures
 * (e.g. 3.12e+62%). Rendering those with `toFixed(2)` blows the tile width and
 * overlaps neighbouring cards, so anything past 1e6 collapses to exponential
 * notation.
 */
export function formatMetricValue(
  v: number | null | undefined,
  signed: boolean,
  suffix: string,
): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = signed && v > 0 ? "+" : "";
  const abs = Math.abs(v);
  const body = abs >= 1e6 || (abs > 0 && abs < 1e-4) ? v.toExponential(2) : v.toFixed(2);
  return `${sign}${body}${suffix}`;
}
