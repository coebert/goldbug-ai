// Pure invariant checks for a portfolio equity snapshot. These are the
// server-side guardrails that catch "impossible totals" BEFORE they land
// in `equity_snapshots` and propagate into every downstream tile/chart.
//
// Design:
//   * Zero I/O and no imports — safe to run in any environment (SSR,
//     server function, edge, unit test).
//   * Returns a list of structured violations rather than throwing, so
//     the caller decides between "log and continue" (broker-authoritative
//     values must never block the tick) and "reject and rewrite".
//   * Every violation has a stable `code` string that logs, alerts, and
//     dashboards can key off without parsing the free-text `message`.
//
// Invariants enforced (with rationale):
//   1. cash_negative              — cash < 0 is only possible with margin,
//                                   which this app does NOT support.
//   2. holdings_negative          — a short position would show up as a
//                                   separate holding with negative qty,
//                                   never as negative aggregate value.
//   3. total_negative             — total equity cannot be negative
//                                   without leverage/margin.
//   4. total_mismatch             — total_value must equal cash +
//                                   holdings_value within TOLERANCE. If
//                                   it doesn't, one of the three fields
//                                   was computed from a stale/mixed
//                                   source and the tile will show
//                                   Invested% + Cash% ≠ 100%.
//   5. invested_exceeds_equity    — holdings_value / total_value > 1.
//                                   This is the exact failure mode the
//                                   user hit ("143.6% invested + 98.9%
//                                   cash"): raw native-currency sums fed
//                                   into holdings_value while total_value
//                                   was FX-normalised.
//   6. cash_exceeds_equity        — cash / total_value > 1. Same class of
//                                   bug in the opposite direction.
//   7. non_finite                 — NaN/Infinity anywhere is always a
//                                   defect and must be caught before it
//                                   corrupts aggregations.
//
// The default tolerance (0.5 in base-currency units) matches the
// DRIFT_EPSILON used by live-cash-sync so we don't flag benign FX
// rounding drift.

export type EquityInvariantInput = {
  portfolioId?: string;
  snapshotDate?: string;
  cash: number;
  holdingsValue: number;
  /** If omitted, derived as cash + holdingsValue. */
  totalValue?: number;
  currency?: string;
};

export type EquityInvariantCode =
  | "non_finite"
  | "cash_negative"
  | "holdings_negative"
  | "total_negative"
  | "total_mismatch"
  | "invested_exceeds_equity"
  | "cash_exceeds_equity";

export type EquityInvariantViolation = {
  code: EquityInvariantCode;
  severity: "warn" | "error";
  message: string;
  /** Machine-readable context — keep small and JSON-serialisable. */
  context: Record<string, number | string | null>;
};

export type EquityInvariantResult = {
  ok: boolean;
  violations: EquityInvariantViolation[];
  /** Convenience — highest severity across all violations, or null. */
  worstSeverity: "warn" | "error" | null;
};

export type EquityInvariantOptions = {
  /** Absolute tolerance in base-currency units. Default 0.5. */
  tolerance?: number;
  /**
   * Relative tolerance for the invested/cash-percentage checks. Default
   * 0.005 (0.5%). Anything within this band of 100% is treated as FX
   * rounding, not a real invariant break.
   */
  pctTolerance?: number;
};

const DEFAULT_TOLERANCE = 0.5;
const DEFAULT_PCT_TOLERANCE = 0.005;

export function checkEquityInvariants(
  input: EquityInvariantInput,
  options: EquityInvariantOptions = {},
): EquityInvariantResult {
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;
  const pctTol = options.pctTolerance ?? DEFAULT_PCT_TOLERANCE;
  const cash = Number(input.cash);
  const holdings = Number(input.holdingsValue);
  const declaredTotal = input.totalValue == null ? null : Number(input.totalValue);
  const total = declaredTotal ?? cash + holdings;

  const violations: EquityInvariantViolation[] = [];
  const ctxBase = {
    portfolio_id: input.portfolioId ?? null,
    snapshot_date: input.snapshotDate ?? null,
    currency: input.currency ?? null,
  };

  const nonFinite = [
    ["cash", cash],
    ["holdings_value", holdings],
    ["total_value", total],
  ] as const;
  for (const [field, v] of nonFinite) {
    if (!Number.isFinite(v)) {
      violations.push({
        code: "non_finite",
        severity: "error",
        message: `${field} is not a finite number (got ${String(v)})`,
        context: { ...ctxBase, field, value: String(v) },
      });
    }
  }

  // If any of the inputs is non-finite, further comparisons are
  // meaningless and would emit noisy secondary violations. Stop here.
  if (violations.some((v) => v.code === "non_finite")) {
    return { ok: false, violations, worstSeverity: "error" };
  }

  if (cash < -tol) {
    violations.push({
      code: "cash_negative",
      severity: "error",
      message: `cash is negative (${cash}); margin/borrow is not supported`,
      context: { ...ctxBase, cash },
    });
  }

  if (holdings < -tol) {
    violations.push({
      code: "holdings_negative",
      severity: "error",
      message: `holdings_value is negative (${holdings}); shorts would be per-position, not aggregate`,
      context: { ...ctxBase, holdings_value: holdings },
    });
  }

  if (total < -tol) {
    violations.push({
      code: "total_negative",
      severity: "error",
      message: `total_value is negative (${total})`,
      context: { ...ctxBase, total_value: total },
    });
  }

  const identity = cash + holdings;
  const mismatch = Math.abs(total - identity);
  if (mismatch > tol) {
    violations.push({
      code: "total_mismatch",
      severity: "error",
      message: `total_value ${total} != cash ${cash} + holdings_value ${holdings} (diff ${mismatch.toFixed(4)})`,
      context: {
        ...ctxBase,
        cash,
        holdings_value: holdings,
        total_value: total,
        diff: Number(mismatch.toFixed(6)),
      },
    });
  }

  // Percentage invariants only make sense when there IS equity to divide
  // by. A zero/negative total is already reported above.
  if (total > tol) {
    const investedPct = holdings / total;
    if (investedPct > 1 + pctTol) {
      violations.push({
        code: "invested_exceeds_equity",
        severity: "error",
        message: `invested is ${(investedPct * 100).toFixed(2)}% of equity (>100%). Likely a currency-unit mismatch between holdings_value and total_value.`,
        context: {
          ...ctxBase,
          invested_pct: Number((investedPct * 100).toFixed(4)),
          holdings_value: holdings,
          total_value: total,
        },
      });
    }
    const cashPct = cash / total;
    if (cashPct > 1 + pctTol) {
      violations.push({
        code: "cash_exceeds_equity",
        severity: "error",
        message: `cash is ${(cashPct * 100).toFixed(2)}% of equity (>100%). total_value is understated or cash is inflated.`,
        context: {
          ...ctxBase,
          cash_pct: Number((cashPct * 100).toFixed(4)),
          cash,
          total_value: total,
        },
      });
    }
  }

  const worstSeverity: "warn" | "error" | null = violations.some((v) => v.severity === "error")
    ? "error"
    : violations.length > 0
      ? "warn"
      : null;

  return { ok: violations.length === 0, violations, worstSeverity };
}

/**
 * Short one-line diagnostic string suitable for logs. Kept separate from
 * the structured `violations[]` so callers get a human-friendly summary
 * without having to format it themselves.
 */
export function summariseInvariantResult(result: EquityInvariantResult): string {
  if (result.ok) return "equity invariants ok";
  return `equity invariants FAILED: ${result.violations.map((v) => v.code).join(", ")}`;
}
