/**
 * Fee-drag-aware optimisation objective.
 *
 * The default optimiser objective is raw net CAGR. That is honest but blunt:
 * two configs with the same net CAGR are treated as equals even when one paid
 * three times as much in commission, minimum-fee floors and slippage to get
 * there. The expensive one is strictly worse out of sample — fee drag is the
 * one component of a backtest that is *certain* to repeat (and to get worse as
 * the account grows into larger, more impactful tickets), whereas gross alpha
 * is the component most likely to decay.
 *
 * This objective therefore maximises
 *
 *     net CAGR  -  λ · (annualised fee drag)
 *
 * subject to the drawdown ceiling remaining a hard constraint: shedding fees
 * must never be bought by carrying more risk. λ is the "penalty per point of
 * annual fee drag" — λ = 0 reproduces the plain net-CAGR ranking, λ = 1 says a
 * point of fees is exactly as bad as a point of lost return, and λ > 1 says
 * fees are worse than that because they are the repeatable part.
 *
 * In bull tapes this matters most: gross returns are broadly similar across
 * configs that stay invested, so the ranking is decided almost entirely by how
 * much of the trend each config hands back to the broker. Penalising fee drag
 * explicitly pushes the optimiser toward fewer, larger, longer-held tickets —
 * exactly the shape that clears the commission floor.
 */

/** Where the drag came from, as % of starting equity over the whole run. */
export type FeeDragBreakdown = {
  /** Percentage commission, after tiering and volume discounts. */
  commissionPct: number;
  /** The part of commission that was the per-ticket minimum, not the rate. */
  minFeePct: number;
  /** Spread crossing plus market impact. */
  slippagePct: number;
  /** Stamp duty, FX conversion, custody — anything not the three above. */
  otherPct: number;
};

export const EMPTY_FEE_DRAG: FeeDragBreakdown = {
  commissionPct: 0,
  minFeePct: 0,
  slippagePct: 0,
  otherPct: 0,
};

/** Total drag implied by a breakdown. `minFeePct` is a subset of commission. */
export function totalFeeDragPct(b: FeeDragBreakdown): number {
  return b.commissionPct + b.slippagePct + b.otherPct;
}

export type FeeDragObjective = {
  kind: "fee_efficient_cagr";
  /** Penalty weight per point of *annualised* fee drag. */
  lambda: number;
  /**
   * Optional soft ceiling on annualised fee drag (%). Breaching it makes a
   * candidate infeasible — reported, but ranked below anything that clears.
   */
  maxAnnualFeeDragPct?: number;
  /**
   * Optional floor on fee efficiency: net CAGR earned per point of fee paid.
   * A config returning 4% while paying 4% in fees has an efficiency of 1.
   */
  minFeeEfficiency?: number;
};

export type NetCagrObjective = { kind: "net_cagr" };

export type OptimizerObjective = NetCagrObjective | FeeDragObjective;

export const NET_CAGR_OBJECTIVE: NetCagrObjective = { kind: "net_cagr" };

/**
 * Default fee-aware objective. λ = 1.5 because a point of fee drag is more
 * reliable than a point of backtested alpha, so it deserves more than
 * one-for-one weight; the 6%/yr ceiling is roughly the point at which a
 * £10k account paying Saxo's minimums cannot outrun its own costs.
 */
export const FEE_EFFICIENT_OBJECTIVE: FeeDragObjective = {
  kind: "fee_efficient_cagr",
  lambda: 1.5,
  maxAnnualFeeDragPct: 6,
};

/**
 * Regime-tuned λ. Bull tapes get the heaviest fee penalty (returns are easy,
 * costs are the differentiator); crisis tapes get the lightest, because there
 * paying up to exit fast is worth it and drawdown control dominates.
 */
export function feeObjectiveForRegime(
  regime: string | null | undefined,
  base: FeeDragObjective = FEE_EFFICIENT_OBJECTIVE,
): FeeDragObjective {
  const r = (regime ?? "").toLowerCase();
  if (r.includes("bull") || r.includes("risk_on") || r.includes("trend")) {
    return { ...base, lambda: base.lambda * 1.4 };
  }
  if (r.includes("crisis") || r.includes("bear") || r.includes("risk_off")) {
    return { ...base, lambda: base.lambda * 0.6 };
  }
  return base;
}

/** Annualise a whole-run drag figure. Guards degenerate / missing horizons. */
export function annualiseFeeDragPct(feeDragPct: number, years: number | undefined): number {
  if (!Number.isFinite(feeDragPct)) return 0;
  if (years === undefined || !Number.isFinite(years) || years <= 0) return feeDragPct;
  return feeDragPct / years;
}

/**
 * Net CAGR earned per point of annual fee paid. Infinity when a profitable
 * config paid nothing; 0 when it lost money (efficiency is meaningless once
 * the numerator is negative, and treating it as 0 keeps ranking monotone).
 */
export function feeEfficiency(cagrPct: number, annualFeeDragPct: number): number {
  if (cagrPct <= 0) return 0;
  if (annualFeeDragPct <= 1e-9) return Number.POSITIVE_INFINITY;
  return cagrPct / annualFeeDragPct;
}

/**
 * The objective value itself: net CAGR less the weighted annualised drag.
 * This is what "fee-adjusted CAGR" means everywhere else in the codebase.
 */
export function feeAdjustedCagr(
  cagrPct: number,
  annualFeeDragPct: number,
  lambda: number,
): number {
  return cagrPct - lambda * Math.max(0, annualFeeDragPct);
}

/**
 * How much net CAGR a config would gain by eliminating the avoidable portion
 * of its drag — the minimum-fee floors and the slippage, but not the
 * irreducible base commission rate. Used to explain *why* a candidate wins.
 */
export function avoidableDragPct(b: FeeDragBreakdown, years?: number): number {
  return annualiseFeeDragPct(b.minFeePct + b.slippagePct, years);
}

/** One executed fill, as the drag estimator needs it. */
export type FeeDragFill = { notional: number; fee: number; side: "BUY" | "SELL" };

/** The friction knobs the estimator can attribute drag to. */
export type FeeDragFrictions = {
  commissionBps?: number;
  minCommission?: number;
  slippageBps?: number;
  buyTaxBps?: number;
};

/**
 * Split realised trading costs into commission / minimum-fee / slippage /
 * other, as % of starting equity.
 *
 * The simulator books commission and tax into `fee` and folds slippage into
 * the fill price, so slippage has to be reconstructed from the configured
 * rate. The minimum-fee component is whatever the booked commission exceeded
 * the pure bps rate by — i.e. the part a bigger ticket would have absorbed
 * for free, which is the single most actionable cost axis for a small account.
 */
export function estimateFeeDrag(
  fills: readonly FeeDragFill[],
  frictions: FeeDragFrictions | undefined,
  startingCash: number,
): FeeDragBreakdown {
  if (!(startingCash > 0)) return EMPTY_FEE_DRAG;
  const commissionRate = (frictions?.commissionBps ?? 0) / 10_000;
  const slipRate = (frictions?.slippageBps ?? 0) / 10_000;
  const taxRate = (frictions?.buyTaxBps ?? 0) / 10_000;

  let commission = 0;
  let minFee = 0;
  let slippage = 0;
  let other = 0;
  for (const f of fills) {
    const notional = Math.abs(f.notional);
    const tax = f.side === "BUY" ? notional * taxRate : 0;
    const booked = Math.max(0, f.fee - tax);
    const ratePart = Math.min(booked, notional * commissionRate);
    commission += booked;
    minFee += booked - ratePart;
    slippage += notional * slipRate;
    other += tax;
  }
  const pct = (x: number) => (x / startingCash) * 100;
  return {
    commissionPct: pct(commission),
    minFeePct: pct(minFee),
    slippagePct: pct(slippage),
    otherPct: pct(other),
  };
}

/** Human-readable one-liner for reports and CLI output. */
export function formatFeeDrag(b: FeeDragBreakdown, years?: number): string {
  const a = (x: number) => annualiseFeeDragPct(x, years).toFixed(2);
  return (
    `fees ${a(totalFeeDragPct(b))}%/yr ` +
    `(comm ${a(b.commissionPct)} of which min ${a(b.minFeePct)}, ` +
    `slip ${a(b.slippagePct)}, other ${a(b.otherPct)})`
  );
}
