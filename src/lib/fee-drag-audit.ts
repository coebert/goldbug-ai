/**
 * Fee-drag self-audit.
 *
 * `estimateFeeDrag` splits realised trading costs into commission, the
 * minimum-fee portion of that commission, reconstructed slippage/impact, and
 * "other" (stamp duty, FX conversion, custody). Because two of those four
 * components are *reconstructed* from the configured friction rates rather
 * than booked by the simulator, a breakdown can silently drift away from the
 * fills that actually executed — a changed fee model, a trade log that dropped
 * rows, or a notional computed in the wrong price unit all look plausible in
 * isolation.
 *
 * This module re-derives the breakdown straight from the executed fills and
 * asserts, component by component, that it reproduces what the backtest
 * reported. It is the fee-side twin of the leverage/borrow `RunAudit`: the
 * optimiser is allowed to prefer cheap configs, but only if the cheapness is
 * real.
 */

import {
  estimateFeeDrag,
  totalFeeDragPct,
  type FeeDragBreakdown,
  type FeeDragFill,
  type FeeDragFrictions,
} from "@/lib/fee-drag-objective";

/** A fill as the backtest trade log records it. */
export type AuditableFill = {
  side: "buy" | "sell" | "BUY" | "SELL";
  quantity: number;
  price: number;
  fee?: number;
};

/** Per-component absolute difference, in percentage points of start equity. */
export type FeeDragDeltas = {
  commissionPct: number;
  minFeePct: number;
  slippagePct: number;
  otherPct: number;
  totalPct: number;
  /** |reported headline feeDragPct − booked fees ÷ starting equity|. */
  bookedFeePct: number;
};

export type FeeDragAudit = {
  /** Breakdown recomputed from the executed fills. */
  reconstructed: FeeDragBreakdown;
  /** Breakdown the run reported. */
  reported: FeeDragBreakdown;
  deltas: FeeDragDeltas;
  /** Fills the reconstruction consumed. */
  fills: number;
  /** Sum of booked fees (commission + taxes) across those fills. */
  bookedFees: number;
  /** Tolerance used, in percentage points. */
  tolerancePct: number;
  /** Human-readable reasons the audit failed; empty when it passed. */
  issues: string[];
  /** True when every component is within tolerance and internally coherent. */
  ok: boolean;
};

const normaliseSide = (s: AuditableFill["side"]): "BUY" | "SELL" =>
  String(s).toUpperCase() === "SELL" ? "SELL" : "BUY";

/** Trade-log rows → the `{ notional, fee, side }` shape the estimator wants. */
export function fillsFromTradeLog(rows: readonly AuditableFill[]): FeeDragFill[] {
  return rows
    .filter((r) => Number.isFinite(r.quantity) && Math.abs(r.quantity) > 0)
    .map((r) => ({
      notional: Math.abs(r.quantity * r.price),
      fee: Number.isFinite(r.fee) ? Math.max(0, r.fee as number) : 0,
      side: normaliseSide(r.side),
    }));
}

/**
 * Default tolerance: fee drag is reported in percent of starting equity, and
 * every input is float arithmetic over thousands of fills, so 1e-6 points
 * (£0.0001 on a £10k book) is tight enough to catch a real modelling drift and
 * loose enough to ignore summation order.
 */
export const FEE_DRAG_TOLERANCE_PCT = 1e-6;

/**
 * Re-derive the fee-drag breakdown from executed fills and compare it with the
 * reported one.
 *
 * Beyond the component-wise match this also checks the two internal
 * invariants that make the breakdown meaningful at all:
 *  - `minFeePct` is a *subset* of `commissionPct`, never larger than it;
 *  - the booked-fee headline (`feeDragPct`) equals commission + other, since
 *    the simulator books commission and taxes into `fee` and folds slippage
 *    into the fill price.
 */
export function auditFeeDrag(args: {
  rows: readonly AuditableFill[];
  frictions: FeeDragFrictions | undefined;
  startingCash: number;
  reported: FeeDragBreakdown;
  /** The headline `feeDragPct` the run reported, when available. */
  reportedFeeDragPct?: number;
  tolerancePct?: number;
}): FeeDragAudit {
  const tol = args.tolerancePct ?? FEE_DRAG_TOLERANCE_PCT;
  const fills = fillsFromTradeLog(args.rows);
  const reconstructed = estimateFeeDrag(fills, args.frictions, args.startingCash);
  const bookedFees = fills.reduce((sum, f) => sum + f.fee, 0);
  const bookedPct =
    args.startingCash > 0 ? (bookedFees / args.startingCash) * 100 : 0;

  const d = (a: number, b: number) => Math.abs(a - b);
  const deltas: FeeDragDeltas = {
    commissionPct: d(reconstructed.commissionPct, args.reported.commissionPct),
    minFeePct: d(reconstructed.minFeePct, args.reported.minFeePct),
    slippagePct: d(reconstructed.slippagePct, args.reported.slippagePct),
    otherPct: d(reconstructed.otherPct, args.reported.otherPct),
    totalPct: d(totalFeeDragPct(reconstructed), totalFeeDragPct(args.reported)),
    bookedFeePct:
      args.reportedFeeDragPct === undefined ? 0 : d(bookedPct, args.reportedFeeDragPct),
  };

  const issues: string[] = [];
  const check = (label: string, delta: number, recon: number, rep: number) => {
    if (delta > tol) {
      issues.push(
        `${label}: reconstructed ${recon.toFixed(6)}% vs reported ${rep.toFixed(6)}% ` +
          `(Δ ${delta.toExponential(2)} > ${tol.toExponential(2)})`,
      );
    }
  };
  check("commission", deltas.commissionPct, reconstructed.commissionPct, args.reported.commissionPct);
  check("min fees", deltas.minFeePct, reconstructed.minFeePct, args.reported.minFeePct);
  check("slippage/impact", deltas.slippagePct, reconstructed.slippagePct, args.reported.slippagePct);
  check("fx/taxes (other)", deltas.otherPct, reconstructed.otherPct, args.reported.otherPct);

  if (args.reported.minFeePct > args.reported.commissionPct + tol) {
    issues.push(
      `min fees ${args.reported.minFeePct.toFixed(6)}% exceed commission ` +
        `${args.reported.commissionPct.toFixed(6)}% — the floor is a subset of commission`,
    );
  }
  if (args.reportedFeeDragPct !== undefined && deltas.bookedFeePct > tol) {
    issues.push(
      `headline feeDragPct ${args.reportedFeeDragPct.toFixed(6)}% does not match booked fees ` +
        `${bookedPct.toFixed(6)}% across ${fills.length} fills`,
    );
  }
  if (
    args.reportedFeeDragPct !== undefined &&
    Math.abs(args.reported.commissionPct + args.reported.otherPct - args.reportedFeeDragPct) > tol
  ) {
    issues.push(
      `commission + other (${(args.reported.commissionPct + args.reported.otherPct).toFixed(6)}%) ` +
        `should equal booked feeDragPct ${args.reportedFeeDragPct.toFixed(6)}%`,
    );
  }

  return {
    reconstructed,
    reported: args.reported,
    deltas,
    fills: fills.length,
    bookedFees,
    tolerancePct: tol,
    issues,
    ok: issues.length === 0,
  };
}

/** One-line summary for reports, CLI output and test failure messages. */
export function formatFeeDragAudit(a: FeeDragAudit): string {
  if (a.ok) {
    return `fee drag reconciles across ${a.fills} fills (max Δ ${Math.max(
      a.deltas.commissionPct,
      a.deltas.minFeePct,
      a.deltas.slippagePct,
      a.deltas.otherPct,
    ).toExponential(2)} pts)`;
  }
  return `fee drag MISMATCH over ${a.fills} fills: ${a.issues.join("; ")}`;
}

/**
 * Throwing form, for use inside a backtest run so a broken cost model fails
 * loudly at the point of production rather than silently ranking first.
 */
export function assertFeeDragMatchesFills(args: Parameters<typeof auditFeeDrag>[0]): FeeDragAudit {
  const audit = auditFeeDrag(args);
  if (!audit.ok) throw new Error(formatFeeDragAudit(audit));
  return audit;
}
