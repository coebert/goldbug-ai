// Execution-engine invariants: no borrowing, no leverage / shorting,
// and positions never exceed available cash. Enforced as post-hoc
// audits over broker-simulator output (or any ledger of the same
// shape) so the guarantees compiled into simulateBrokerExecution can't
// silently regress.
//
// These are pure functions with no I/O — safe to call from hot paths,
// tests, backtests, and the live executor's reconciliation step.

import type {
  SimState,
  SimSnapshot,
  SimDecision,
  SimRejection,
} from "./broker-simulator";

/** A single invariant violation, tagged for actionable diagnostics. */
export type InvariantViolation = {
  code:
    | "NEGATIVE_CASH"
    | "NEGATIVE_QUANTITY"
    | "BORROWED_ON_BUY"
    | "SHORTED_ON_SELL"
    | "SNAPSHOT_TOTAL_DRIFT"
    | "BUY_EXCEEDS_PRIOR_CASH"
    | "NON_FINITE"
    | "STEP_ORDERING";
  step?: number;
  symbol?: string;
  message: string;
  /** Machine-readable evidence (numbers involved). */
  detail?: Record<string, number | string | boolean>;
};

export type InvariantReport = {
  ok: boolean;
  violations: InvariantViolation[];
};

/**
 * Absolute tolerance for float comparisons on money quantities.
 * The simulator does exact arithmetic in double precision — a
 * tolerance smaller than a millionth of a currency unit rejects real
 * drift while accepting normal rounding noise from mark-to-market
 * multiplications.
 */
export const MONEY_EPS = 1e-6;


function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Check every invariant against a ledger produced by the execution
 * engine. Returns a full report — never throws. Prefer this in
 * production hot paths so a violation is logged rather than
 * killing the request.
 */
export function checkExecutionInvariants(args: {
  initial: SimState;
  decisions: SimDecision[];
  snapshots: SimSnapshot[];
  rejections: SimRejection[];
  markPrices?: Record<string, number>;
}): InvariantReport {
  const { initial, decisions, snapshots, rejections, markPrices } = args;
  const violations: InvariantViolation[] = [];

  // ---- state-shape sanity --------------------------------------------------
  if (!isFiniteNum(initial.cash) || initial.cash < 0) {
    violations.push({
      code: "NEGATIVE_CASH",
      message: `initial cash must be finite & >= 0 (got ${initial.cash})`,
      detail: { cash: Number(initial.cash) },
    });
  }

  // ---- monotonic step ordering --------------------------------------------
  // Simulator increments `step` per decision (including rejected ones),
  // so snapshot steps must be strictly increasing but not necessarily
  // contiguous.
  for (let i = 1; i < snapshots.length; i += 1) {
    if (snapshots[i].step <= snapshots[i - 1].step) {
      violations.push({
        code: "STEP_ORDERING",
        step: snapshots[i].step,
        message: `snapshot step ${snapshots[i].step} not > previous ${snapshots[i - 1].step}`,
      });
    }
  }

  // Index rejections by decisionId so we can tell which decisions
  // never produced a snapshot (i.e. were rejected outright).
  const rejectedIds = new Set(rejections.map((r) => r.decisionId));
  const snapshotIds = new Set(snapshots.map((s) => s.decisionId));
  for (const d of decisions) {
    if (!rejectedIds.has(d.id) && !snapshotIds.has(d.id)) {
      violations.push({
        code: "STEP_ORDERING",
        symbol: d.symbol,
        message: `decision ${d.id} produced neither a snapshot nor a rejection`,
      });
    }
  }

  // ---- per-snapshot invariants --------------------------------------------
  let prevCash = initial.cash;

  for (const s of snapshots) {
    if (!isFiniteNum(s.cash) || !isFiniteNum(s.holdingsValue) || !isFiniteNum(s.totalValue)) {
      violations.push({
        code: "NON_FINITE",
        step: s.step,
        message: `non-finite snapshot values`,
        detail: {
          cash: Number(s.cash),
          holdingsValue: Number(s.holdingsValue),
          totalValue: Number(s.totalValue),
        },
      });
      continue;
    }

    // 1) NO BORROWING — cash is never negative.
    if (s.cash < -MONEY_EPS) {
      violations.push({
        code: "NEGATIVE_CASH",
        step: s.step,
        message: `cash went negative after step ${s.step}: ${s.cash}`,
        detail: { cash: s.cash },
      });
    }

    // 2) NO LEVERAGE / SHORTING — every holding qty >= 0.
    for (const h of s.holdings) {
      if (!isFiniteNum(h.quantity) || h.quantity < 0) {
        violations.push({
          code: "NEGATIVE_QUANTITY",
          step: s.step,
          symbol: h.symbol,
          message: `holding ${h.symbol} qty ${h.quantity} < 0 after step ${s.step}`,
          detail: { quantity: Number(h.quantity) },
        });
      }
    }

    // 3) SNAPSHOT TOTALS — total_value = cash + holdings_value.
    const expectedTotal = s.cash + s.holdingsValue;
    if (Math.abs(expectedTotal - s.totalValue) > MONEY_EPS) {
      violations.push({
        code: "SNAPSHOT_TOTAL_DRIFT",
        step: s.step,
        message: `totalValue ${s.totalValue} != cash + holdingsValue ${expectedTotal}`,
        detail: {
          cash: s.cash,
          holdingsValue: s.holdingsValue,
          totalValue: s.totalValue,
          drift: s.totalValue - expectedTotal,
        },
      });
    }

    // Re-derive holdings_value from marks and compare — catches an
    // engine that silently doubles or drops a lot from the ledger.
    let derived = 0;
    for (const h of s.holdings) {
      const mark = markPrices?.[h.symbol];
      // Mirror simulator's markToMarket exactly: mark wins when
      // provided (even if <=0 → clamped to 0); otherwise avgCost;
      // then clamp non-positive/non-finite to 0.
      const raw = isFiniteNum(mark) ? mark : h.avgCost;
      const price = isFiniteNum(raw) && raw > 0 ? raw : 0;
      derived += h.quantity * price;
    }
    // Tolerate a wider band here since marks may include the fill
    // price for the current symbol that we don't have visibility of.
    if (markPrices && Math.abs(derived - s.holdingsValue) > Math.max(MONEY_EPS, Math.abs(derived) * 1e-9)) {
      // Only enforce when the caller passed marks — with no marks the
      // simulator falls back to avgCost + fillPrice which we can't
      // fully reconstruct here without symbol context.
      violations.push({
        code: "SNAPSHOT_TOTAL_DRIFT",
        step: s.step,
        message: `holdingsValue ${s.holdingsValue} disagrees with mark-derived ${derived}`,
        detail: { derived, reported: s.holdingsValue, drift: s.holdingsValue - derived },
      });
    }

    // 4) BUY NEVER EXCEEDS PRIOR CASH — cost + fee <= prev cash.
    //    Keyed off the recorded side, not off "cash went down": a sell whose
    //    fee outweighs its proceeds also drains cash, and charging it the
    //    buy budget test compares its notional against money it never spent.
    if (s.side === "BUY" && s.fillQuantity > 0 && s.fillPrice >= 0 && s.fee >= 0) {
      const spend = s.fillQuantity * s.fillPrice + s.fee;
      // Relative slack alongside the absolute epsilon: quantity x price
      // accumulates float error proportional to the notional, so a fixed
      // 1e-6 tolerance produced spurious violations on larger trades.
      const slack = Math.max(MONEY_EPS, Math.abs(prevCash) * 1e-7);
      if (spend > prevCash + slack) {
        violations.push({
          code: "BUY_EXCEEDS_PRIOR_CASH",
          step: s.step,
          message: `buy spent ${spend} but only ${prevCash} was available`,
          detail: { spend, priorCash: prevCash, fillQuantity: s.fillQuantity, fillPrice: s.fillPrice, fee: s.fee },
        });
      }
    }

    prevCash = s.cash;
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Throwing variant — use in tests and dev-mode assertions where a
 * violation should fail loudly. Message includes every violation.
 */
export function assertExecutionInvariants(args: Parameters<typeof checkExecutionInvariants>[0]): void {
  const report = checkExecutionInvariants(args);
  if (!report.ok) {
    const lines = report.violations
      .map((v) => `  [${v.code}${v.step ? ` step=${v.step}` : ""}${v.symbol ? ` sym=${v.symbol}` : ""}] ${v.message}`)
      .join("\n");
    throw new Error(`Execution invariants violated (${report.violations.length}):\n${lines}`);
  }
}
