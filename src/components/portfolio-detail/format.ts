// Number/text formatting helpers for the portfolio detail route (verbatim).

export function fmtNum(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toFixed(digits);
}

export function fmtPct(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${(v * 100).toFixed(1)}%`;
}

export function keywordMatch(text: string, symbol: string, name: string) {
  const t = text.toLowerCase();
  if (t.includes(symbol.toLowerCase())) return true;
  const first = name.split(/\s+/)[0]?.toLowerCase();
  if (first && first.length > 3 && t.includes(first)) return true;
  return false;
}

/**
 * Format a metric value for the equity-curve tiles.
 *
 * Degenerate backtests can produce astronomically large annualised figures
 * (e.g. 3.12e+62%). Rendering those with `toFixed(2)` blows the tile width and
 * overlaps neighbouring cards, so anything past 1e6 collapses to exponential
 * notation.
 */
export export function formatMetricValue(
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

