// Pure P&L sanity checks. Given two equity anchors and any cash movements
// (deposits, withdrawals, cross-mode transfers, external fees) that occurred
// between them, flag equity jumps that don't line up with an economically
// plausible explanation.
//
// The equity identity we lean on is:
//
//   equity_after ≈ equity_before + net_cash_in + trading_pnl
//
// where `net_cash_in` is external cash flowing into the portfolio (deposits
// positive, withdrawals/transfers-out negative) and `trading_pnl` is the
// mark-to-market change on held positions plus realised P&L from any trades
// that happened in the window.
//
// The checker is intentionally conservative: it flags only jumps that are
// clearly implausible (magnitude AND ratio-based thresholds combined) so
// tiles don't cry wolf on every normal move.

export type PnlSanitySeverity = "info" | "warn" | "critical";

export type PnlSanityCode =
  | "ok"
  | "no_prior_anchor"
  | "negative_equity"
  | "unexplained_jump"
  | "sign_mismatch"
  | "flat_portfolio_moved"
  | "cash_flow_vs_equity_mismatch";

export interface PnlSanityFlag {
  code: PnlSanityCode;
  severity: PnlSanitySeverity;
  message: string;
  /** Absolute equity delta in portfolio currency (currEquity - prevEquity). */
  equityDelta: number;
  /** Portion of the equity delta explainable by external cash flow. */
  netCashFlow: number;
  /**
   * The unexplained residual: equityDelta - netCashFlow. If holdings existed
   * and prices moved this can legitimately be non-zero (mark-to-market P&L).
   * Callers can pass `expectedTradingPnl` when known to tighten the check.
   */
  residual: number;
}

export interface PnlSanityInput {
  prevEquity: number | null;
  currEquity: number;
  /**
   * Net external cash into the portfolio between the two anchors. Deposits
   * are positive; withdrawals / cross-mode transfers out are negative.
   */
  netCashFlow?: number;
  /**
   * Optional: independently computed trading P&L (mark-to-market delta on
   * held positions + realised P&L from trades in the window). When supplied
   * the checker uses it to tighten the "unexplained jump" test.
   */
  expectedTradingPnl?: number;
  /**
   * Whether the portfolio held any positions across the window. If it was
   * flat and there were no cash flows, ANY equity change is suspicious.
   */
  hadHoldings?: boolean;
  /**
   * Portfolio currency label — used only for message formatting.
   */
  currency?: string;
  /**
   * Maximum single-step move (as a fraction of prior equity) that is
   * considered plausible for a portfolio holding positions. Defaults to 20%.
   */
  maxSingleStepPct?: number;
  /**
   * Absolute residual (unexplained ccy) below which the check does not fire,
   * regardless of ratio. Prevents noise on tiny portfolios. Defaults to
   * 5 units of portfolio currency.
   */
  minAbsoluteResidual?: number;
}

export interface PnlSanityResult {
  ok: boolean;
  flags: PnlSanityFlag[];
}

const DEFAULT_MAX_STEP_PCT = 0.2;
const DEFAULT_MIN_ABS_RESIDUAL = 5;

function fmt(n: number, ccy: string): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return `${sign}${ccy} ${abs.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
}

export function checkPnlSanity(input: PnlSanityInput): PnlSanityResult {
  const {
    prevEquity,
    currEquity,
    netCashFlow = 0,
    expectedTradingPnl,
    hadHoldings = true,
    currency = "GBP",
    maxSingleStepPct = DEFAULT_MAX_STEP_PCT,
    minAbsoluteResidual = DEFAULT_MIN_ABS_RESIDUAL,
  } = input;

  const flags: PnlSanityFlag[] = [];
  const ccy = currency.toUpperCase();

  // No prior anchor → nothing to compare against.
  if (prevEquity == null || !Number.isFinite(prevEquity)) {
    return {
      ok: true,
      flags: [
        {
          code: "no_prior_anchor",
          severity: "info",
          message: "no prior equity snapshot to compare against",
          equityDelta: 0,
          netCashFlow,
          residual: 0,
        },
      ],
    };
  }

  const equityDelta = currEquity - prevEquity;
  const residual = equityDelta - netCashFlow;
  const denom = Math.max(1, Math.abs(prevEquity));
  const stepPct = Math.abs(equityDelta) / denom;
  const residualPct = Math.abs(residual) / denom;

  // 1. Negative equity is always critical.
  if (currEquity < 0) {
    flags.push({
      code: "negative_equity",
      severity: "critical",
      message: `equity went negative (${fmt(currEquity, ccy)}) — likely a data or FX error`,
      equityDelta,
      netCashFlow,
      residual,
    });
  }

  // 2. Flat portfolio with no cash flow but equity moved → data error.
  if (
    !hadHoldings &&
    Math.abs(netCashFlow) < minAbsoluteResidual &&
    Math.abs(equityDelta) >= minAbsoluteResidual
  ) {
    flags.push({
      code: "flat_portfolio_moved",
      severity: "warn",
      message:
        `portfolio held no positions and had no cash flow, ` +
        `yet equity changed by ${fmt(equityDelta, ccy)}`,
      equityDelta,
      netCashFlow,
      residual,
    });
  }

  // 3. Large single-step jump vs prior equity.
  if (stepPct > maxSingleStepPct && Math.abs(equityDelta) >= minAbsoluteResidual) {
    flags.push({
      code: "unexplained_jump",
      severity: stepPct > maxSingleStepPct * 2 ? "critical" : "warn",
      message:
        `equity moved ${(stepPct * 100).toFixed(1)}% in a single step ` +
        `(${fmt(equityDelta, ccy)}), exceeding the ${(maxSingleStepPct * 100).toFixed(0)}% plausibility ceiling`,
      equityDelta,
      netCashFlow,
      residual,
    });
  }

  // 4. Cash-flow / equity mismatch: when trading P&L is explicitly supplied,
  //    the identity equity_after - equity_before ≈ netCashFlow + tradingPnl
  //    must hold to within the noise floor.
  if (
    typeof expectedTradingPnl === "number" &&
    Number.isFinite(expectedTradingPnl)
  ) {
    const mismatch = residual - expectedTradingPnl;
    const mismatchPct = Math.abs(mismatch) / denom;
    if (
      Math.abs(mismatch) >= minAbsoluteResidual &&
      mismatchPct > maxSingleStepPct / 2
    ) {
      flags.push({
        code: "cash_flow_vs_equity_mismatch",
        severity: mismatchPct > maxSingleStepPct ? "critical" : "warn",
        message:
          `equity change ${fmt(equityDelta, ccy)} doesn't reconcile with ` +
          `cash flow ${fmt(netCashFlow, ccy)} + expected trading P&L ` +
          `${fmt(expectedTradingPnl, ccy)} (residual ${fmt(mismatch, ccy)})`,
        equityDelta,
        netCashFlow,
        residual,
      });
    }
  } else if (
    // 5. No trading-P&L reference, but residual (equity move not explained by
    //    cash flow) is huge vs prior equity → probable data glitch.
    Math.abs(residual) >= minAbsoluteResidual &&
    residualPct > maxSingleStepPct
  ) {
    flags.push({
      code: "cash_flow_vs_equity_mismatch",
      severity: residualPct > maxSingleStepPct * 2 ? "critical" : "warn",
      message:
        `unexplained residual of ${fmt(residual, ccy)} after netting ` +
        `cash flow ${fmt(netCashFlow, ccy)} out of an equity move of ` +
        `${fmt(equityDelta, ccy)}`,
      equityDelta,
      netCashFlow,
      residual,
    });
  }

  // 6. Direction sanity: expected trading P&L says up, equity net of cash
  //    flow went sharply down (or vice versa) by a meaningful amount.
  if (
    typeof expectedTradingPnl === "number" &&
    Number.isFinite(expectedTradingPnl) &&
    Math.abs(expectedTradingPnl) >= minAbsoluteResidual &&
    Math.abs(residual) >= minAbsoluteResidual &&
    Math.sign(expectedTradingPnl) !== 0 &&
    Math.sign(residual) !== 0 &&
    Math.sign(expectedTradingPnl) !== Math.sign(residual)
  ) {
    flags.push({
      code: "sign_mismatch",
      severity: "warn",
      message:
        `trading P&L (${fmt(expectedTradingPnl, ccy)}) and equity residual ` +
        `(${fmt(residual, ccy)}) disagree on direction`,
      equityDelta,
      netCashFlow,
      residual,
    });
  }

  return { ok: flags.length === 0, flags };
}
