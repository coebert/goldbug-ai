// Target-weight buy sizing.
//
// Problem this solves: sizing buys purely from "cash × pct" lets the engine
// nibble the same name repeatedly. Each nibble is individually legal (it fits
// the remaining room under the per-symbol cap) but the sequence walks the
// position right up to the concentration cap in small, commission-heavy
// tickets.
//
// Instead we decide a *desired portfolio weight* for the symbol first, and the
// order becomes the gap between that target and what we already hold. Two
// consequences fall out for free:
//   - a position can never be accumulated past its target weight, and
//   - once we're inside the tolerance band, the gap is 0 and we simply skip,
//     rather than topping up with a sub-scale ticket.
//
// Pure module: no I/O, no clock, safe to unit test.

export type TargetWeightInput = {
  /** Baseline weight for an average-conviction name (fraction of NAV). */
  baseWeight: number;
  /** Hard per-symbol concentration cap (fraction of NAV). */
  maxWeight: number;
  /** |alpha composite| magnitude in [0, 1]; null/absent → neutral. */
  alphaMag?: number | null;
  /** AI conviction in [0, 1]; null/absent → neutral. */
  conviction?: number | null;
  /**
   * Optional volatility scaler in (0, ∞): 1 = normal vol, >1 for calm names,
   * <1 for jumpy ones. Clamped to [0.5, 1.5] so it can nudge, not dominate.
   */
  volScale?: number | null;
};

/**
 * Desired weight for a symbol, in [0, maxWeight]. Conviction and alpha lift
 * the baseline toward — but never past — the concentration cap.
 */
export function desiredWeight(input: TargetWeightInput): number {
  const maxWeight = Math.max(0, num(input.maxWeight));
  const base = Math.max(0, Math.min(maxWeight, num(input.baseWeight)));
  if (maxWeight <= 0 || base <= 0) return 0;

  const alpha = clamp01(input.alphaMag ?? 0);
  const conv = clamp01(input.conviction ?? 0);
  // Both signals must be present to earn extra weight; a strong prior with no
  // conviction (or vice versa) stays near the baseline.
  const strength = clamp01(Math.sqrt(alpha * conv));
  const vol = clamp(num(input.volScale ?? 1) || 1, 0.5, 1.5);

  const target = (base + (maxWeight - base) * strength) * vol;
  return clamp(target, 0, maxWeight);
}

export type TargetWeightSpendInput = {
  /** Portfolio NAV in base currency. */
  nav: number;
  /** Current market value of the existing position in base currency. */
  currentValue: number;
  /** Desired weight (fraction of NAV) — typically from `desiredWeight`. */
  targetWeight: number;
  /**
   * Minimum economic ticket in base currency. Gaps smaller than this are not
   * worth a commission, so we wait rather than nibble.
   */
  minTicketBase?: number | null;
  /**
   * Dead band as a fraction of NAV (default 0.5%). Inside the band the
   * position counts as "at target".
   */
  tolerancePctOfNav?: number | null;
};

export type TargetWeightSpend = {
  /** Base-currency notional the buy may spend (0 = do not trade). */
  spend: number;
  /** Value gap to target before any min-ticket test. */
  gap: number;
  /** Current weight of the position. */
  currentWeight: number;
  targetWeight: number;
  reason: "ok" | "at_target" | "over_target" | "gap_below_min_ticket" | "no_nav";
  note: string | null;
};

/**
 * Convert a target weight into an allowed buy notional. Never returns more
 * than the distance to target, so repeated calls converge on the target
 * instead of stacking past it.
 */
export function targetWeightSpend(input: TargetWeightSpendInput): TargetWeightSpend {
  const nav = num(input.nav);
  const currentValue = Math.max(0, num(input.currentValue));
  const targetWeight = Math.max(0, num(input.targetWeight));

  if (!(nav > 0)) {
    return {
      spend: 0, gap: 0, currentWeight: 0, targetWeight,
      reason: "no_nav", note: "no NAV available for target-weight sizing",
    };
  }

  const currentWeight = currentValue / nav;
  const gap = targetWeight * nav - currentValue;
  const tol = Math.max(0, num(input.tolerancePctOfNav ?? 0.005)) * nav;
  const minTicket = Math.max(0, num(input.minTicketBase ?? 0));

  const fmt = (w: number) => `${(w * 100).toFixed(1)}%`;
  const band = `${fmt(currentWeight)}→${fmt(targetWeight)}`;

  if (gap <= 0) {
    return {
      spend: 0, gap, currentWeight, targetWeight,
      reason: currentWeight > targetWeight ? "over_target" : "at_target",
      note: `target weight ${band}: already at/above target`,
    };
  }
  if (gap <= tol) {
    return {
      spend: 0, gap, currentWeight, targetWeight,
      reason: "at_target",
      note: `target weight ${band}: within tolerance band`,
    };
  }
  if (minTicket > 0 && gap < minTicket) {
    return {
      spend: 0, gap, currentWeight, targetWeight,
      reason: "gap_below_min_ticket",
      note: `target weight ${band}: gap ${gap.toFixed(0)} < min ticket ${minTicket.toFixed(0)} — waiting rather than nibbling`,
    };
  }
  return {
    spend: gap, gap, currentWeight, targetWeight,
    reason: "ok",
    note: `target weight ${band} (room ${gap.toFixed(0)})`,
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v: unknown): number {
  return clamp(Math.abs(num(v)), 0, 1);
}
