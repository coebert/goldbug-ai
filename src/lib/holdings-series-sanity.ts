// Runtime sanity checks that catch sparkline ↔ headline-percentage drift
// before it reaches the UI. A "series" here is the price array a Sparkline
// renders; the "baseline" is the avg_cost/opened_at anchor the "% since
// purchase" tile is computed from. If those two ever disagree the user sees
// an upward-sloping chart next to a red number (or vice versa), which we
// treat as a bug worth surfacing loudly.

export type HoldingSeriesLike = {
  symbol: string;
  avg_cost: number;
  closes: number[];
  currentPrice: number | null;
  pctChangeSincePurchase: number | null;
  points: number;
};

export type SeriesSanityIssue = {
  symbol: string;
  code:
    | "length_mismatch"
    | "baseline_drift"
    | "current_price_drift"
    | "sign_disagreement"
    | "magnitude_disagreement"
    | "non_finite";
  detail: string;
};

const EPS_ABS = 1e-6;
const EPS_REL = 1e-4; // 0.01% tolerance on floating-point equality
const MAG_TOL = 0.005; // 50bps: sparkline % vs headline % may disagree at most this much

function nearlyEqual(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff <= EPS_ABS) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff / scale <= EPS_REL;
}

/**
 * Validate a single holding series. Returns [] when everything lines up.
 * Callers should log/report every issue rather than throw — this runs on the
 * hot render path.
 */
export function auditHoldingSeries(h: HoldingSeriesLike): SeriesSanityIssue[] {
  const issues: SeriesSanityIssue[] = [];

  // Length invariant: `points` must equal the array length we hand the Sparkline.
  if (h.points !== h.closes.length) {
    issues.push({
      symbol: h.symbol,
      code: "length_mismatch",
      detail: `points=${h.points} but closes.length=${h.closes.length}`,
    });
  }

  for (const v of h.closes) {
    if (!Number.isFinite(v)) {
      issues.push({
        symbol: h.symbol,
        code: "non_finite",
        detail: `non-finite value in closes: ${String(v)}`,
      });
      return issues; // further checks are unsafe
    }
  }

  if (h.avg_cost > 0 && h.closes.length > 0) {
    // Baseline invariant: the first plotted point IS the purchase anchor.
    if (!nearlyEqual(h.closes[0], h.avg_cost)) {
      issues.push({
        symbol: h.symbol,
        code: "baseline_drift",
        detail: `closes[0]=${h.closes[0]} ≠ avg_cost=${h.avg_cost}`,
      });
    }
  }

  const last = h.closes.length > 0 ? h.closes[h.closes.length - 1] : null;
  if (h.currentPrice != null && last != null && !nearlyEqual(h.currentPrice, last)) {
    // The headline price MUST match the tail of the sparkline; otherwise the
    // sparkline is showing a different "now" than the numeric tile.
    issues.push({
      symbol: h.symbol,
      code: "current_price_drift",
      detail: `currentPrice=${h.currentPrice} ≠ closes[last]=${last}`,
    });
  }

  if (
    h.pctChangeSincePurchase != null
    && h.avg_cost > 0
    && h.closes.length >= 2
  ) {
    const first = h.closes[0];
    const tail = h.closes[h.closes.length - 1];
    const sparkPct = (tail - first) / first;
    const headline = h.pctChangeSincePurchase;

    // Sign check — the most user-visible symptom. Small values near zero are
    // exempt so a flat holding at ±0.01% doesn't spam warnings.
    const bothMeaningful = Math.abs(sparkPct) > 1e-4 && Math.abs(headline) > 1e-4;
    if (bothMeaningful && Math.sign(sparkPct) !== Math.sign(headline)) {
      issues.push({
        symbol: h.symbol,
        code: "sign_disagreement",
        detail: `sparkline ${(sparkPct * 100).toFixed(3)}% vs headline ${(headline * 100).toFixed(3)}%`,
      });
    } else if (Math.abs(sparkPct - headline) > MAG_TOL) {
      issues.push({
        symbol: h.symbol,
        code: "magnitude_disagreement",
        detail: `sparkline ${(sparkPct * 100).toFixed(3)}% vs headline ${(headline * 100).toFixed(3)}% (Δ>${(MAG_TOL * 100).toFixed(1)}bp)`,
      });
    }
  }

  return issues;
}

export function auditHoldingSeriesBatch(list: HoldingSeriesLike[]): SeriesSanityIssue[] {
  const out: SeriesSanityIssue[] = [];
  for (const h of list) out.push(...auditHoldingSeries(h));
  return out;
}

export function formatIssue(i: SeriesSanityIssue): string {
  return `[holdings-series] ${i.symbol} ${i.code}: ${i.detail}`;
}
