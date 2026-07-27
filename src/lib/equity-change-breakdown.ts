// Pure helper: decomposes total equity change over a window into
// (Deposits, Withdrawals, Fees/Dividends/Interest, Trading P&L).
//
// The app currently stores every external cash-flow (broker top-ups,
// sim fund events, dividends credited, cash-interest, commissions and
// fees booked directly to cash) in a single flat `deposits` array
// exposed by getPortfolio / buildAllPortfoliosEquity. We split that
// array heuristically by magnitude:
//
//   |amount| >= threshold  → user Deposit (positive) / Withdrawal (negative)
//   |amount| <  threshold  → Fee / Dividend / Interest bucket
//
// Trading P&L is the residual so the four buckets always sum to
// (endEquity − startEquity). Callers must slice `equity` and
// `deposits` to the window they want summarised.
//
// The threshold defaults to 25 (in the portfolio's currency), which
// cleanly separates typical broker fees/dividends (single-digit to
// low-double-digit) from realistic user deposits. It is exposed as
// an option so tests and callers can override it.

export type EquityPoint = { snapshot_date: string; total_value: number };
export type DepositLike = { date: string; amount: number };

export type BreakdownBucket = {
  key: "deposits" | "withdrawals" | "feesDivInterest" | "tradingPnl";
  label: string;
  amount: number;
  /** Contribution in percentage points of the starting equity. */
  pctPoints: number;
};

export type EquityChangeBreakdown = {
  startEquity: number;
  endEquity: number;
  totalChange: number;
  totalPct: number;
  buckets: BreakdownBucket[];
};

export type EquityChangeBreakdownOptions = {
  /** Absolute amount at/above which a cash-flow counts as a deposit
   * or withdrawal rather than a fee / dividend / interest. */
  feeThreshold?: number;
};

export function computeEquityChangeBreakdown(
  equity: EquityPoint[],
  deposits: DepositLike[],
  options: EquityChangeBreakdownOptions = {},
): EquityChangeBreakdown | null {
  const feeThreshold = options.feeThreshold ?? 25;
  const rows = equity.filter((r) => Number.isFinite(Number(r.total_value)));
  if (rows.length < 2) return null;
  const start = rows[0];
  const end = rows[rows.length - 1];
  const startEquity = Number(start.total_value);
  const endEquity = Number(end.total_value);
  const totalChange = endEquity - startEquity;

  // Only cash-flows strictly after the start snapshot count; anything
  // dated on/before startDate is already baked into startEquity.
  const startDate = start.snapshot_date;
  const endDate = end.snapshot_date;

  let depositTotal = 0;
  let withdrawalTotal = 0;
  let feesDivInterestTotal = 0;
  for (const d of deposits) {
    if (!d || !d.date) continue;
    if (d.date <= startDate) continue;
    if (d.date > endDate) continue;
    const amt = Number(d.amount);
    if (!Number.isFinite(amt) || amt === 0) continue;
    if (Math.abs(amt) < feeThreshold) {
      feesDivInterestTotal += amt;
    } else if (amt > 0) {
      depositTotal += amt;
    } else {
      withdrawalTotal += amt; // negative
    }
  }

  const externalTotal = depositTotal + withdrawalTotal + feesDivInterestTotal;
  const tradingPnl = totalChange - externalTotal;

  const denom = startEquity > 0 ? startEquity : 0;
  const asPct = (v: number) => (denom > 0 ? (v / denom) * 100 : 0);

  const buckets: BreakdownBucket[] = [
    { key: "deposits", label: "Deposits", amount: depositTotal, pctPoints: asPct(depositTotal) },
    { key: "withdrawals", label: "Withdrawals", amount: withdrawalTotal, pctPoints: asPct(withdrawalTotal) },
    { key: "tradingPnl", label: "Trading P&L", amount: tradingPnl, pctPoints: asPct(tradingPnl) },
    { key: "feesDivInterest", label: "Fees / Dividends / Interest", amount: feesDivInterestTotal, pctPoints: asPct(feesDivInterestTotal) },
  ];

  return {
    startEquity,
    endEquity,
    totalChange,
    totalPct: asPct(totalChange),
    buckets,
  };
}
