// Single source of truth for the capital-adjusted return %.
//
// Every equity % change surface in the app (dashboard mode-summary
// tile, home-page portfolio card range badge, chart trailing pct,
// daily-changes card, equity-change breakdown) MUST divide trading
// pnl by the SAME denominator so a large mid-window deposit cannot
// masquerade as a huge trading gain.
//
// The rule:
//
//   pct = tradingPnl / (baseline + netFlow) * 100
//
// where
//   - tradingPnl = (endEquity − startEquity) − netFlow
//   - baseline   = start-of-window equity (already includes any flows
//                  dated on/before the window's left edge)
//   - netFlow    = signed sum of external cash-flows strictly AFTER
//                  the window's left edge and up to & including its
//                  right edge (deposits positive, withdrawals negative)
//
// Edge cases the helper handles once so callers don't drift:
//   - baseline <= 0 → returns 0 (never Infinity / NaN)
//   - denom collapses to <= 0 (large withdrawal) → falls back to
//     baseline to keep pct finite
//   - non-finite inputs → returns 0
//
// If you need to compute a % change of equity anywhere in the codebase
// and external cash-flows are in scope, call this helper. Do not
// re-derive `pnl / previous` inline — that path is what produced the
// +1101% Balanced-sim regression.

export type CapitalAdjustedInput = {
  /** Trading pnl over the window, already net of external flows. */
  pnl: number;
  /** Start-of-window equity anchor. */
  baseline: number;
  /**
   * Signed sum of external cash-flows in the window (deposits
   * positive, withdrawals negative). Set to 0 when there are no
   * flows or when the caller has opted into raw (include-flows) math.
   */
  netFlow: number;
};

/**
 * Returns the capital-adjusted trading return as a percentage.
 * See file header for the contract.
 */
export function capitalAdjustedPct(input: CapitalAdjustedInput): number {
  const { pnl, baseline, netFlow } = input;
  if (!Number.isFinite(pnl)) return 0;
  if (!Number.isFinite(baseline) || baseline <= 0) return 0;
  const flow = Number.isFinite(netFlow) ? netFlow : 0;
  const denomRaw = baseline + flow;
  const denom = denomRaw > 0 ? denomRaw : baseline;
  if (denom <= 0) return 0;
  return (pnl / denom) * 100;
}

/**
 * Convenience: returns the safe denominator alone. Useful for the
 * (rare) callers that need to know the capital base separately from
 * the pct, e.g. to display "£X trading pnl on £Y of capital".
 */
export function capitalAdjustedDenom(baseline: number, netFlow: number): number {
  if (!Number.isFinite(baseline) || baseline <= 0) return 0;
  const flow = Number.isFinite(netFlow) ? netFlow : 0;
  const denomRaw = baseline + flow;
  return denomRaw > 0 ? denomRaw : baseline;
}
